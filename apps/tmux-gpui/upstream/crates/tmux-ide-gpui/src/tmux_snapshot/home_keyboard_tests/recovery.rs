use super::*;
use crate::tmux_snapshot::home::recovery::{Action, Capability};

fn prepare(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.browser_state.request = 7;
    view.browser_state.surface = browser::Surface::Home;
    view.browser_state.fleet = Some(browser::fleet::Fleet {
        preferences: None,
        groups: vec![],
        omitted_groups: 0,
    });
    view.browser_state.home_agents = Some(
        serde_json::from_value(serde_json::json!({
            "revision":9,"phase":"partial","observedSessions":1,"totalSessions":2,
            "truncatedSessions":1,"truncatedRows":0,"note":null,"rows":[]
        }))
        .unwrap(),
    );
    view.browser_state.home_agent_recovery = Some(Capability {
        revision: 9,
        can_retry: true,
        can_load_more: true,
    });
    view.home_render(window, cx);
}

#[gpui::test]
fn recovery_preserves_search_selection_request_and_rejects_stale_duplicate(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        prepare(&mut view, window, cx);
        view.browser_state.home_agents.as_mut().unwrap().rows.push(
            serde_json::from_value(serde_json::json!({
                "key":"retained-key","sessionId":"session-a","paneId":"pane-a",
                "name":"Unicode 界 agent","sessionLabel":"Session Alpha",
                "status":"WORKING","attention":false,"available":true
            }))
            .unwrap(),
        );
        view.input_interrupted = true;
        view
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, cx| {
        let controls = view.home_filter.as_mut().unwrap();
        controls
            .search
            .update(cx, |input, cx| input.set_text_selected("Unicode 界", cx));
        view.recover_home_agents(6, 9, Action::Retry, cx);
        view.recover_home_agents(7, 8, Action::Retry, cx);
    });
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.home_filter.as_ref().unwrap().selected.as_deref(),
            Some("retained-key")
        );
    });
    view.update(cx, |view, cx| {
        view.recover_home_agents(7, 9, Action::Retry, cx);
        view.recover_home_agents(7, 9, Action::LoadMore, cx);
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::HomeAgentRecovery {
            request: 7,
            roster_revision: 9,
            action: Action::Retry
        }
    ));
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, cx| {
        let controls = view.home_filter.as_ref().unwrap();
        assert_eq!(controls.search.read(cx).text(), "Unicode 界");
        assert_eq!(controls.selected.as_deref(), Some("retained-key"));
        assert_eq!(view.browser_request, 7);
        assert!(view.input_interrupted);
    });
    view.update(cx, |view, cx| {
        view.browser_state.home_agents.as_mut().unwrap().revision = 10;
        view.browser_state
            .home_agent_recovery
            .as_mut()
            .unwrap()
            .revision = 10;
        view.recover_home_agents(7, 10, Action::LoadMore, cx);
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::HomeAgentRecovery {
            roster_revision: 10,
            action: Action::LoadMore,
            ..
        }
    ));
}

#[gpui::test]
fn full_recovery_queue_reports_failure_without_consuming_revision(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        prepare(&mut view, window, cx);
        view
    });
    view.update(cx, |view, cx| {
        view.recover_home_agents(7, 9, Action::Retry, cx);
        let controls = view.home_filter.as_ref().unwrap();
        assert!(controls.recovery_error);
        assert!(controls.recovery_queued.is_none());
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, cx| {
        view.recover_home_agents(7, 9, Action::Retry, cx)
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::HomeAgentRecovery { .. }
    ));
}

#[test]
fn recovery_command_serializes_exact_current_request() {
    assert_eq!(
        serde_json::to_value(browser::Command::HomeAgentRecovery {
            request: 7,
            roster_revision: 9,
            action: Action::LoadMore
        })
        .unwrap(),
        serde_json::json!({"type":"home-agent-recovery","request":7,"rosterRevision":9,"action":"load-more"})
    );
}

#[gpui::test]
fn recovery_shortcuts_do_not_steal_search_text(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        prepare(&mut view, window, cx);
        view
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("r");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::HomeAgentRecovery {
            action: Action::Retry,
            ..
        }
    ));
    view.update(cx, |view, _| {
        view.browser_state.home_agents.as_mut().unwrap().revision = 10;
        view.browser_state
            .home_agent_recovery
            .as_mut()
            .unwrap()
            .revision = 10;
    });
    cx.simulate_keystrokes("/");
    cx.simulate_input("rm");
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, cx| {
        assert_eq!(
            view.home_filter.as_ref().unwrap().search.read(cx).text(),
            "rm"
        )
    });
    cx.simulate_keystrokes("escape");
    cx.simulate_keystrokes("m");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::HomeAgentRecovery {
            action: Action::LoadMore,
            roster_revision: 10,
            ..
        }
    ));
}

#[gpui::test]
fn recovery_waits_for_foreground_acknowledgement(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        prepare(&mut view, window, cx);
        view.presence = Presence::new(true);
        view
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, cx| {
        view.recover_home_agents(7, 9, Action::Retry, cx);
        assert!(view.home_filter.as_ref().unwrap().recovery_queued.is_none());
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn recovery_shortcuts_preserve_marked_text_and_modal_isolation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        prepare(&mut view, window, cx);
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let search = view.home_filter.as_ref().unwrap().search.clone();
            search.read(cx).focus.clone().focus(window, cx);
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", Some(1..1), window, cx)
            });
            for key in ["r", "m"] {
                assert!(!view.home_filter_key(
                    &crate::tmux_snapshot::fit_test_support::key_down(key),
                    window,
                    cx
                ));
            }
            assert!(search.read(cx).is_composing());
            view.open_picker(window, cx);
            view.recover_home_agents(7, 9, Action::Retry, cx);
            assert!(view.home_filter.as_ref().unwrap().recovery_queued.is_none());
        });
    });
    assert!(receiver.try_recv().is_err());
}

/// `select` moves `browser_request` before the publication for it arrives: a
/// recovery from either side of that gap must wait for the publication.
#[gpui::test]
fn recovery_waits_until_the_publication_catches_up(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        prepare(&mut view, window, cx);
        view
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, cx| {
        view.browser_request = 8;
        view.recover_home_agents(7, 9, Action::Retry, cx);
        assert!(receiver.try_recv().is_err(), "old request");
        view.recover_home_agents(8, 9, Action::Retry, cx);
        assert!(receiver.try_recv().is_err(), "unpublished request");
        view.browser_state.request = 8;
        view.recover_home_agents(8, 9, Action::Retry, cx);
        assert!(receiver.try_recv().is_ok(), "current request");
    });
}
