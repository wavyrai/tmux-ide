#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use std::sync::mpsc;
fn choice(id: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: None,
        window_id: None,
        browser_icon: None,
        window_label: None,
    }
}
fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    crate::tmux_snapshot::fit_test_support::fixture_view(
        window,
        cx,
        sender,
        0,
        browser::State {
            request: 0,
            workspace_agents: None,
            home_agents: None,
            attention_supported: false,
            attention_selection_rejected: None,
            attention_agents: None,
            create_session: Some(browser::CreateSession {
                phase: browser::CreatePhase::Idle,
                error: None,
                revision: 0,
            }),
            surface: browser::Surface::Home,
            home_phase: browser::HomePhase::Live,
            input_ready: true,
            sessions: vec![choice("session-a", "Session Alpha")],
            panes: vec![choice("pane-a", "Editor")],
            selected_session: Some("session-a".into()),
            ..Default::default()
        },
    )
}

#[test]
fn shared_name_limits_and_wire_zero_request() {
    assert_eq!(name("  project  ").as_deref(), Some("project"));
    assert_eq!(name("\u{FEFF}project\u{FEFF}").as_deref(), Some("project"));
    for invalid in ["", "-session", "a\nname", "a\u{85}name", "\u{85}project"] {
        assert!(name(invalid).is_none());
    }
    assert!(name(&"🙂".repeat(50)).is_some());
    assert!(name(&"🙂".repeat(51)).is_none());
    assert_eq!(
        serde_json::to_value(browser::Command::CreateSession {
            request: 0,
            name: "project".into()
        })
        .unwrap(),
        serde_json::json!({"type":"create-session","request":0,"name":"project"})
    );
}
#[gpui::test]
fn submit_once_and_coalesced_ack_without_pending(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        view.open_new_session(0, window, cx);
        let input = view.new_session.as_ref().unwrap().input.clone();
        assert!(input.read(cx).focus.is_focused(window));
        input.update(cx, |input, cx| input.set_text_selected("new-project", cx));
        assert!(!view.offer_terminal_input(cx));
        view.submit_new_session(window, cx);
        view.submit_new_session(window, cx);
        view.open_new_session(0, window, cx);
        assert!(view.new_session.is_none());
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::CreateSession { request: 0, name } if name == "new-project"));
        assert!(receiver.try_recv().is_err());
        view.refresh_new_session(cx); // old idle is not acknowledgement
        assert!(view.new_session_queued.is_some());
        view.browser_state.create_session.as_mut().unwrap().revision = 1;
        view.refresh_new_session(cx); // pending may have been coalesced away
        assert!(view.new_session_queued.is_none());
        assert!(view.can_create_session());
    }));
}
#[gpui::test]
fn missing_capability_stale_request_failed_owner_and_queue_failure(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let capability = view.browser_state.create_session.take();
            view.open_new_session(0, window, cx);
            assert!(view.new_session.is_none());
            view.browser_state.create_session = capability;
            view.open_new_session(1, window, cx);
            assert!(view.new_session.is_none());
            view.open_new_session(0, window, cx);
            view.new_session
                .as_ref()
                .unwrap()
                .input
                .clone()
                .update(cx, |input, cx| input.set_text_selected("new-project", cx));
            assert!(
                view.browser_commands
                    .as_ref()
                    .unwrap()
                    .try_send(browser::Command::Home { request: 9 })
                    .is_ok()
            );
            view.submit_new_session(window, cx);
            assert!(view.new_session.as_ref().unwrap().error.is_some());
            assert!(view.new_session_queued.is_none());
            receiver.try_iter().for_each(drop);
            view.browser_state.create_session.as_mut().unwrap().phase =
                browser::CreatePhase::Failed;
            view.refresh_new_session(cx);
            assert!(view.new_session.is_none());
            assert!(!view.can_create_session());
            view.browser_state.create_session.as_mut().unwrap().phase = browser::CreatePhase::Idle;
            view.open_new_session(0, window, cx);
            view.browser_request = 1;
            view.submit_new_session(window, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}
#[gpui::test]
fn composition_blocks_submit_and_cancel_does_not_commit_to_terminal(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_new_session(0, window, cx);
            let input = view.new_session.as_ref().unwrap().input.clone();
            input.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", None, window, cx)
            });
            view.submit_new_session(window, cx);
            assert!(receiver.try_recv().is_err());
            assert!(view.new_session.is_some());
            view.close_new_session(window, cx);
            input.update(cx, |input, cx| {
                input.replace_text_in_range(None, "late", window, cx)
            });
            assert!(receiver.try_recv().is_err());
            assert!(view.marked.is_empty());
        })
    });
}

#[gpui::test]
fn initial_home_zero_actual_button_keyboard_and_escape(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.frame = None;
        view.painted_frame = None;
        view.browser_state.input_ready = false;
        view.browser_state.selected_session = None;
        view.browser_state.selected_pane = None;
        view.browser_state.frame = None;
        view.browser_state.panes.clear();
        view.browser_state.regions.clear();
        view.input_geometry = None;
        view.input_cell_width = None;
        view
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    let button = cx.debug_bounds("home-new-session").unwrap();
    cx.simulate_click(button.center(), Modifiers::default());
    cx.simulate_input("first-project");
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| assert!(view.new_session.is_none()));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    let button = cx.debug_bounds("home-new-session").unwrap();
    cx.simulate_click(button.center(), Modifiers::default());
    cx.simulate_input("first-project");
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::CreateSession {request:0,name} if name == "first-project")
    );
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        assert_eq!(view.browser_request, 0);
        assert_eq!(view.browser_state.surface, browser::Surface::Home);
        assert!(view.new_session_queued.is_some());
        assert!(!view.browser_state.input_ready);
    });
}

mod local;
