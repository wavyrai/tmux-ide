use super::*;

#[gpui::test]
fn unavailable_theme_is_inert_and_skipped_until_appearance_arrives(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let bounds = cx.debug_bounds("home-theme").unwrap();
    cx.simulate_click(bounds.center(), Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.picker.is_none()));
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("tab tab");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert_eq!(view.home_action_index(window), Some(2))
        });
    });
    cx.simulate_keystrokes("shift-tab");
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            assert_eq!(view.home_action_index(window), Some(0));
            view.browser_state.appearance = Some(
                serde_json::from_value(serde_json::json!({
                    "selected":"dark","system":"dark","error":null,
                    "theme":{"canvas":1,"background":2,"foreground":3,"cursor":4,"surface":5,
                        "active":6,"muted":7,"accent":8,"palette":vec![9;256]},
                    "options":[{"id":"dark","name":"Dark"}]
                }))
                .unwrap(),
            );
        });
        window.draw(cx).clear(cx);
    });
    assert_eq!(cx.debug_bounds("home-theme").unwrap(), bounds);
    cx.simulate_keystrokes("tab");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert_eq!(view.home_action_index(window), Some(1))
        });
    });
    cx.simulate_keystrokes("enter");
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    cx.update(|window, cx| {
        let appearance = view.update(cx, |view, _| {
            assert!(view.picker.is_some());
            assert!(!view.terminal_focus.is_focused(window));
            view.browser_state.appearance.take()
        });
        window.draw(cx).clear(cx);
        view.update(cx, |view, _| {
            assert!(view.picker.is_some());
            assert!(!view.terminal_focus.is_focused(window));
            view.browser_state.appearance = appearance;
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("escape tab tab");
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            assert_eq!(view.home_action_index(window), Some(1));
            view.browser_state.appearance = None;
        });
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, _| {
            assert!(view.terminal_focus.is_focused(window))
        });
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn workspace_theme_without_appearance_does_not_open_a_picker(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.surface = browser::Surface::Workspace;
        view
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    let theme = cx.debug_bounds("open-theme-picker").unwrap();
    cx.simulate_click(theme.center(), Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.picker.is_none()));
    assert!(receiver.try_recv().is_err());
}
