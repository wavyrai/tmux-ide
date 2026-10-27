use super::*;

#[gpui::test]
fn f6_overlay_preserves_home_and_workspace_geometry(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let home = cx.debug_bounds("tmux-home").unwrap();
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f6");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(cx.debug_bounds("tmux-home").unwrap(), home);
    assert!(cx.debug_bounds("commands-popover").is_some());
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    let geometry = view.read_with(cx, |view, _| view.input_geometry);
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f6");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(view.read_with(cx, |view, _| view.input_geometry), geometry);
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.input_interrupted));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn f6_duplicate_labels_dispatch_exact_selected_id_and_reject_stale_request(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.sessions =
            vec![choice("first", "Duplicate"), choice("second", "Duplicate")];
        view
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f6");
    cx.simulate_input("Duplicate");
    cx.simulate_keystrokes("down enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Session { request: 8, id } if id == "second")
    );
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker(window, cx);
            view.browser_request += 1;
            view.choose_picker(Target::Session("first".into()), window, cx);
            assert!(view.picker.is_some());
        })
    });
    assert!(receiver.try_recv().is_err());
}
