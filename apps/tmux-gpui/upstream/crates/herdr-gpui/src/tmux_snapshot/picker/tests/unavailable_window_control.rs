use super::*;

#[gpui::test]
fn unavailable_window_control_waits_for_current_capability_without_moving_terminal(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.browser_state.request = view.browser_request;
            view.browser_state.selected_session = Some("session-a".into());
            view.browser_state.pane_actions = None;
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let bounds = cx.debug_bounds("workspace-new-window").unwrap();
    let geometry = view.read_with(cx, |view, _| view.input_geometry.unwrap().0);
    cx.simulate_click(bounds.center(), Modifiers::default());
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        assert_eq!(view.browser_request, 7);
        assert_eq!(view.input_geometry.unwrap().0, geometry);
        assert!(view.picker.is_none());
    });
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.pane_actions = Some(browser::PaneActions {
                token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
        });
        window.draw(cx).clear(cx);
    });
    assert_eq!(cx.debug_bounds("workspace-new-window").unwrap(), bounds);
    cx.simulate_click(bounds.center(), Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction {
            request: 7,
            action: crate::tmux_snapshot::pane_actions::Action::NewWindow,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
}
