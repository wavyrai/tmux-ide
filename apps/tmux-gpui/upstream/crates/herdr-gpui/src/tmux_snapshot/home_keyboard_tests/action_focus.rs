use super::*;

// simulate_keystrokes emits key-down only. Native buttons activate on key-up;
// dispatch that explicitly instead of invoking the callback directly.

#[gpui::test]
fn home_actions_tab_enter_space_and_escape_keep_input_owned(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.appearance = Some(
            serde_json::from_value(serde_json::json!({
                "selected":"dark","system":"dark","error":null,
                "theme":{"canvas":1,"background":2,"foreground":3,"cursor":4,"surface":5,
                    "active":6,"muted":7,"accent":8,"palette":vec![9;256]},
                "options":[{"id":"dark","name":"Dark"}]
            }))
            .unwrap(),
        );
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("tab");
    cx.update(|window, cx| {
        assert!(window.last_input_was_keyboard());
        view.read_with(cx, |v, _| assert_eq!(v.home_action_index(window), Some(0)));
    });
    cx.simulate_keystrokes("enter");
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    view.read_with(cx, |v, _| assert!(v.picker.is_some()));
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.read_with(cx, |v, _| assert!(v.terminal_focus.is_focused(window)));
    });
    cx.simulate_keystrokes("tab tab");
    cx.update(|window, cx| {
        view.read_with(cx, |v, _| assert_eq!(v.home_action_index(window), Some(1)));
    });
    cx.simulate_keystrokes("space");
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("space").unwrap(),
    });
    view.read_with(cx, |v, _| assert!(v.picker.is_some()));
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape shift-tab");
    cx.update(|window, cx| {
        view.read_with(cx, |v, _| assert_eq!(v.home_action_index(window), Some(2)));
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.read_with(cx, |v, _| assert!(v.terminal_focus.is_focused(window)));
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn home_focused_refresh_activates_once_without_opening_selected_agent(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_agents = Some(
            serde_json::from_value(serde_json::json!({
                "revision":9,"phase":"live","observedSessions":1,"totalSessions":1,
                "truncatedSessions":0,"truncatedRows":0,"note":null,
                "rows":[{"key":"agent","sessionId":"session-a","paneId":"pane-a",
                    "name":"Agent","sessionLabel":"Session Alpha","status":"WORKING",
                    "attention":false,"available":true}]
            }))
            .unwrap(),
        );
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("shift-tab enter");
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Refresh { request: 8 }
    ));
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        view.read_with(cx, |v, _| assert!(v.terminal_focus.is_focused(window)));
    });
}

#[gpui::test]
fn home_navigation_retires_action_focus_before_terminal_surface(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("tab");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            assert_eq!(v.home_action_index(window), Some(0));
            v.select(Selection::Session("session-a".into()), window, cx);
            assert!(
                v.home_filter
                    .as_ref()
                    .unwrap()
                    .actions
                    .iter()
                    .all(|f| !f.is_focused(window))
            );
        });
        window.draw(cx).clear(cx);
        view.read_with(cx, |v, _| {
            assert!(v.terminal_focus.is_focused(window));
            assert_eq!(v.home_action_index(window), None);
        });
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Session { request: 8, .. }
    ));
    assert!(receiver.try_recv().is_err());
}
