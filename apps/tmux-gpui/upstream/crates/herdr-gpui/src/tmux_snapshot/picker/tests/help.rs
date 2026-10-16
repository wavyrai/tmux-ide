use super::*;

#[gpui::test]
fn help_and_preview_changes_search_return_without_terminal_commands(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(520.), px(400.)));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    let geometry = view.read_with(cx, |view, _| view.input_geometry);
    receiver.try_iter().for_each(drop);
    for (entry, mode, query, expected) in [
        (
            "Using tmux-ide",
            Mode::Help,
            "coverage",
            "incomplete observations",
        ),
        (
            "new",
            Mode::WhatsNew,
            "symbol fallbacks",
            "saved for the next launch",
        ),
    ] {
        cx.simulate_keystrokes("f5");
        // Full label avoids matching pane creation commands on Workspace.
        cx.simulate_input(if entry == "new" {
            "What’s new"
        } else {
            entry
        });
        cx.simulate_keystrokes("enter");
        cx.simulate_input(query);
        cx.simulate_keystrokes("down up enter");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |view, _| {
            let picker = view.picker.as_ref().unwrap();
            assert!(picker.mode == mode);
            assert_eq!(picker.rows.len(), 1);
            assert!(picker.rows[0].label.contains(expected));
            assert_eq!(view.input_geometry, geometry);
            assert!(view.input_interrupted);
        });
        assert!(cx.debug_bounds("commands-popover").unwrap().size.width <= px(496.));
        cx.simulate_keystrokes("escape");
        view.read_with(cx, |view, _| {
            assert!(view.picker.as_ref().unwrap().mode == Mode::Commands)
        });
        cx.simulate_keystrokes("escape");
    }
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn help_reference_composition_and_replaced_picker_reject_activation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            for mode in [Mode::Help, Mode::WhatsNew] {
                view.open_picker_mode(mode, window, cx);
                let search = view.picker.as_ref().unwrap().search.clone();
                search.update(cx, |input, cx| {
                    input.replace_and_mark_text_in_range(None, "界", None, window, cx)
                });
                for key in ["escape", "enter"] {
                    view.picker_key(
                        &KeyDownEvent {
                            keystroke: Keystroke::parse(key).unwrap(),
                            is_held: false,
                            prefer_character_input: false,
                            layout: None,
                        },
                        window,
                        cx,
                    );
                    assert!(view.picker.as_ref().unwrap().mode == mode);
                    assert!(search.read(cx).is_composing());
                }
            }
            view.open_picker_mode(Mode::Navigation, window, cx);
            for action in [Action::Help, Action::WhatsNew] {
                view.choose_picker(Target::Command(action), window, cx);
                assert!(view.picker.as_ref().unwrap().mode == Mode::Navigation);
            }
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn help_prose_wraps_inside_narrow_scrollable_reference(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(340.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("Using tmux-ide");
    cx.simulate_keystrokes("enter");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let list = cx.debug_bounds("picker-results").unwrap();
    let first = cx.debug_bounds("picker-row-0").unwrap();
    assert!(
        first.size.height > px(40.),
        "prose must wrap to multiple lines"
    );
    assert!(first.left() >= list.left() && first.right() <= list.right());
    for _ in 0..7 {
        cx.simulate_keystrokes("down");
    }
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let last = cx.debug_bounds("picker-row-7").unwrap();
    assert!(
        last.top() >= list.top() && last.bottom() <= list.bottom(),
        "keyboard navigation must reveal the complete final paragraph"
    );
    view.read_with(cx, |view, _| {
        assert_eq!(view.picker.as_ref().unwrap().selected, 7)
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn help_entry_preserves_commands_marked_text(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_commands(window, cx);
            let search = view.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", None, window, cx)
            });
            for action in [Action::Help, Action::WhatsNew] {
                // This is the same admission called by retained pointer row callbacks.
                view.choose_picker(Target::Command(action), window, cx);
                assert!(view.picker.as_ref().unwrap().mode == Mode::Commands);
                assert!(search.read(cx).is_composing());
            }
        })
    });
    assert!(receiver.try_recv().is_err());
}
