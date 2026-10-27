use super::*;

#[gpui::test]
fn fullscreen_shortcut_roundtrips_from_terminal_and_picker(cx: &mut TestAppContext) {
    cx.update(super::super::bind_keys);
    let (sender, receiver) = std::sync::mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = browser_fixture(cx, sender);
        view.input_interrupted = false;
        view.terminal_focus.focus(window, cx);
        view
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-cmd-f");
    cx.update(|window, _| assert!(window.is_fullscreen()));
    cx.simulate_keystrokes("ctrl-cmd-f");
    cx.update(|window, _| assert!(!window.is_fullscreen()));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker(window, cx);
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("ctrl-cmd-f");
    cx.update(|window, cx| {
        assert!(window.is_fullscreen());
        assert!(view.read(cx).picker.is_some());
    });
    cx.simulate_keystrokes("ctrl-cmd-f");
    cx.update(|window, cx| {
        assert!(!window.is_fullscreen());
        assert!(view.read(cx).picker.is_some());
    });
    // Window geometry may emit viewport fits; never send the shortcut to tmux.
    assert!(receiver.try_iter().all(|command| matches!(
        command,
        super::super::super::browser::Command::Input {
            input: super::super::super::keys::Input::Resize { .. },
            ..
        }
    )));
}
