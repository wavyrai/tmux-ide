use super::*;

#[gpui::test]
fn theme_is_in_the_menu_bar_and_f5_not_homes_action_row(cx: &mut TestAppContext) {
    // The appearance bezel paints in is process-wide: hold it, so no test
    // running alongside changes it under this one.
    let _appearance = bezel_theme::lock_appearance();
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
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // Home's toolbar has no Theme button (#746)...
    assert!(cx.debug_bounds("home-theme").is_none());
    // ...and Tab never lands on its old slot, appearance or not.
    cx.simulate_keystrokes("tab tab");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert_eq!(view.home_action_index(window), Some(2))
        });
    });
    // The menu bar's Choose Theme… still opens the theme picker.
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_theme_picker(window, cx));
    });
    assert!(view.read_with(cx, |view, _| view.picker.is_some()));
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
