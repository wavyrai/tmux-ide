use super::*;

/// New window left the title bar (#746); Cmd-T, the menu bar's New Window
/// shortcut, still creates one, and only with a current pane capability.
#[gpui::test]
fn cmd_t_makes_a_new_window_only_with_a_current_capability(cx: &mut TestAppContext) {
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
    assert!(cx.debug_bounds("workspace-new-window").is_none());
    let geometry = view.read_with(cx, |view, _| view.input_geometry.unwrap().0);
    cx.simulate_keystrokes("cmd-t");
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        assert_eq!(view.browser_request, 7);
        assert_eq!(view.input_geometry.unwrap().0, geometry);
    });
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready_pane(view, false));
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-t");
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
