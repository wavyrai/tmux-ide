use super::*;

#[gpui::test]
fn filtering_pane_menu_shrinks_surface_without_changing_terminal_geometry(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(650.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.browser_state.selected_session = Some("session-a".into());
            view.browser_state.pane_actions = Some(browser::PaneActions {
                token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
            view.input_interrupted = true;
            view.open_header_actions(window, cx);
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let full = cx.debug_bounds("commands-popover").unwrap();
    let geometry = view.read_with(cx, |view, _| view.input_geometry);
    cx.simulate_input("zzzz_no_matching_pane_action");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let filtered = cx.debug_bounds("commands-popover").unwrap();
    assert!(filtered.size.height < full.size.height);
    assert_eq!(filtered.size.width, full.size.width);
    assert_eq!(view.read_with(cx, |view, _| view.input_geometry), geometry);
    view.read_with(cx, |view, _| {
        assert!(view.picker.as_ref().unwrap().rows.is_empty());
        assert!(view.input_interrupted);
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| assert!(view.picker.is_none()));
}
