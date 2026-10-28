use super::*;
#[gpui::test]
fn font_discovery_blocks_changes_and_picker_never_routes_terminal_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("terminal font");
    cx.simulate_keystrokes("enter down enter");
    view.read_with(cx, |view, _| {
        assert!(view.picker.as_ref().unwrap().mode == Mode::Font);
        assert!(!view.terminal_font.saving);
        assert_eq!(view.terminal_font.config.size, 14.);
    });
    cx.simulate_input("Mono");
    cx.simulate_keystrokes("escape");
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn changed_font_height_invalidates_then_repaints_shared_cursor_and_grid(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.terminal_font.config.size = 21.;
            view.input_interrupted = true;
            view.invalidate_font_geometry(cx);
            assert!(view.input_geometry.is_none());
            assert!(view.input_cell_width.is_none());
            assert!(view.painted_frame.is_none());
            assert!(view.input_interrupted);
        });
        window.draw(cx).clear(cx);
    });
    view.read_with(cx, |view, _| {
        let (_, cursor) = view.input_geometry.unwrap();
        assert_eq!(cursor.size.height, px(30.));
        assert_eq!(view.terminal_height(), 30.);
        assert!(view.input_interrupted);
    });
    assert!(receiver.try_iter().all(|command| matches!(
        command,
        browser::Command::Presence { .. }
            | browser::Command::Input {
                input: crate::tmux_snapshot::keys::Input::Resize { .. },
                ..
            }
    )));
}
