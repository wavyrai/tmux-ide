use super::*;

fn agents(count: usize) -> browser::home_agents::Roster {
    serde_json::from_value(serde_json::json!({
        "revision":9,"phase":"live","observedSessions":1,"totalSessions":1,
        "truncatedSessions":0,"truncatedRows":0,"note":null,
        "rows":(0..count).map(|i| serde_json::json!({
            "key":format!("opaque-{i}"),"sessionId":"session-a","paneId":format!("pane-{i}"),
            "name":"Same label","sessionLabel":"Session Alpha","status":"WORKING",
            "attention":false,"available":i != 1
        })).collect::<Vec<_>>()
    }))
    .unwrap()
}

#[gpui::test]
fn home_roster_keyboard_skips_unavailable_and_opens_current_revision(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.home_agents = Some(agents(12));
        view.input_interrupted = true;
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("down");
    view.read_with(cx, |v, _| {
        assert_eq!(
            v.home_filter.as_ref().unwrap().selected.as_deref(),
            Some("opaque-2")
        )
    });
    cx.simulate_keystrokes("end");
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    view.read_with(cx, |v, _| {
        let controls = v.home_filter.as_ref().unwrap();
        assert_eq!(controls.selected.as_deref(), Some("opaque-11"));
        assert!(controls.scroll.offset().y < px(0.));
    });
    cx.simulate_keystrokes("home");
    cx.simulate_keystrokes("pagedown");
    cx.simulate_keystrokes("pageup");
    cx.simulate_keystrokes("home");
    view.update(cx, |v, _| {
        v.browser_state.home_agents.as_mut().unwrap().revision = 10
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::OpenAgent { request:8, from_request:7, roster_revision:10, key } if key == "opaque-0")
    );
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| assert!(v.input_interrupted));
}

#[gpui::test]
fn home_roster_selection_reconciles_filter_removal_and_unavailability(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_agents = Some(agents(4));
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("down");
    view.update(cx, |v, cx| {
        v.browser_state.home_agents.as_mut().unwrap().rows.remove(2);
        v.reconcile_home_selection(cx);
        assert_eq!(
            v.home_filter.as_ref().unwrap().selected.as_deref(),
            Some("opaque-3")
        );
        let search = v.home_filter.as_ref().unwrap().search.clone();
        search.update(cx, |input, cx| input.set_text_selected("no match", cx));
        v.reconcile_home_selection(cx);
        assert!(v.home_filter.as_ref().unwrap().selected.is_none());
        search.update(cx, |input, cx| input.set_text_selected("", cx));
        v.reconcile_home_selection(cx);
        assert_eq!(
            v.home_filter.as_ref().unwrap().selected.as_deref(),
            Some("opaque-0")
        );
        v.browser_state.home_agents.as_mut().unwrap().phase =
            browser::home_agents::Phase::Unavailable;
        v.reconcile_home_selection(cx);
        assert!(v.home_filter.as_ref().unwrap().selected.is_none());
    });
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn home_roster_navigation_preserves_search_composition_and_overlay_ownership(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.home_agents = Some(agents(4));
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("/");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let search = v.home_filter.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "に", Some(0..1), window, cx)
            });
            for key in [
                "enter", "escape", "up", "down", "pageup", "pagedown", "home", "end",
            ] {
                let event = crate::tmux_snapshot::fit_test_support::key_down(key);
                assert!(!v.home_filter_key(&event, window, cx));
            }
            assert!(search.read(cx).is_composing());
            search.update(cx, |input, cx| input.unmark_text(window, cx));
            v.open_commands(window, cx);
            let event = crate::tmux_snapshot::fit_test_support::key_down("enter");
            assert!(!v.home_filter_key(&event, window, cx));
        });
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn home_enter_does_not_open_replacement_before_redraw(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.home_agents = Some(agents(4));
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let roster = v.browser_state.home_agents.as_mut().unwrap();
            roster.rows.remove(0);
            roster.revision += 1;
            let event = crate::tmux_snapshot::fit_test_support::key_down("enter");
            assert!(v.home_filter_key(&event, window, cx));
            assert!(receiver.try_recv().is_err());
            assert_eq!(v.browser_request, 7);
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::OpenAgent { key, roster_revision:10, .. } if key == "opaque-2")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn home_roster_irrelevant_publication_preserves_manual_scroll(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_agents = Some(agents(12));
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    view.update(cx, |v, cx| {
        let controls = v.home_filter.as_ref().unwrap();
        controls.scroll.set_offset(point(px(0.), px(-80.)));
        v.browser_state.home_agents.as_mut().unwrap().rows[11].available = false;
        v.reconcile_home_selection(cx);
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    view.read_with(cx, |v, _| {
        let controls = v.home_filter.as_ref().unwrap();
        assert_eq!(controls.selected.as_deref(), Some("opaque-0"));
        assert_eq!(controls.scroll.offset().y, px(-80.));
    });
    assert!(receiver.try_recv().is_err());
}
