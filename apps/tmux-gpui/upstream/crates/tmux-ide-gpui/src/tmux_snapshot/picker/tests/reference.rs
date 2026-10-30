use super::*;

#[gpui::test]
fn reference_search_navigation_and_escape_do_not_dispatch_terminal(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(520.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let before = cx.debug_bounds("tmux-home").unwrap();
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("keyboard shortcuts");
    cx.simulate_keystrokes("enter");
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    assert_eq!(cx.debug_bounds("tmux-home").unwrap(), before);
    assert!(cx.debug_bounds("commands-popover").unwrap().size.width <= px(496.));
    cx.simulate_keystrokes("down up enter");
    cx.simulate_input("Home retry");
    view.read_with(cx, |view, _| {
        let picker = view.picker.as_ref().unwrap();
        assert!(picker.mode == Mode::Reference);
        assert_eq!(picker.rows.len(), 1);
        assert!(picker.rows[0].label.contains("when available"));
        assert!(view.input_interrupted);
    });
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| {
        assert!(view.picker.as_ref().unwrap().mode == Mode::Commands)
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert!(view.picker.is_none());
            assert!(view.terminal_focus.is_focused(window));
            assert!(view.input_interrupted);
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn reference_marked_composition_and_stale_action_remain_isolated(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker_mode(Mode::Reference, window, cx);
            let search = view.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", None, window, cx)
            });
            for key in ["escape", "enter"] {
                view.picker_key(
                    &crate::tmux_snapshot::fit_test_support::key_down(key),
                    window,
                    cx,
                );
                assert!(view.picker.as_ref().unwrap().mode == Mode::Reference);
                assert!(search.read(cx).is_composing());
            }
            view.open_picker_mode(Mode::Navigation, window, cx);
            view.choose_picker(Target::Command(Action::Shortcuts), window, cx);
            assert!(view.picker.as_ref().unwrap().mode == Mode::Navigation);
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn workspace_reference_keeps_canvas_and_interrupted_input_closed(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    let before = view.read_with(cx, |view, _| view.input_geometry);
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("keyboard shortcuts");
    cx.simulate_keystrokes("enter");
    cx.simulate_input("terminal");
    cx.simulate_keystrokes("down enter up");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, _| {
        assert!(view.picker.as_ref().unwrap().mode == Mode::Reference);
        assert_eq!(view.input_geometry, before);
        assert!(view.input_interrupted);
    });
    cx.simulate_keystrokes("escape escape");
    assert!(
        receiver.try_recv().is_err(),
        "reference must not resize or send input"
    );
    view.read_with(cx, |view, _| assert!(view.input_interrupted));
}
