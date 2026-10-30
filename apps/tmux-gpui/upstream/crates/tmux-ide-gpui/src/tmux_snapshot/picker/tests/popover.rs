use super::*;

#[gpui::test]
fn commands_float_without_resizing_home_and_escape_restores_focus(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(520.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let before = cx.debug_bounds("tmux-home").unwrap();
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(cx.debug_bounds("tmux-home").unwrap(), before);
    let panel = cx.debug_bounds("commands-popover").unwrap();
    assert!(panel.size.width <= px(496.));
    assert!(panel.origin.x >= px(0.));
    cx.simulate_input("appearance");
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        let picker = view.picker.as_ref().unwrap();
        assert!(picker.mode == Mode::Commands);
        assert_eq!(picker.rows.len(), 1);
        assert!(!current(&view.browser_state, &picker.rows[0].target));
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            assert!(view.picker.is_none());
            assert!(view.terminal_focus.is_focused(window));
        });
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn commands_overlay_keeps_workspace_canvas_and_arrow_return_routing(cx: &mut TestAppContext) {
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
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(view.read_with(cx, |view, _| view.input_geometry), before);
    cx.simulate_input("switch session");
    cx.simulate_keystrokes("down up enter");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker
                .as_ref()
                .is_some_and(|p| p.mode == Mode::Navigation)
        );
        assert!(view.input_interrupted);
    });
    assert!(
        receiver.try_recv().is_err(),
        "popover must not resize or type into tmux"
    );
}

#[gpui::test]
fn backdrop_down_up_dismisses_without_activating_sidebar_or_terminal(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    let sidebar = cx.debug_bounds("tmux-sidebar-row-0").unwrap().center();
    let terminal = view.read_with(cx, |view, _| {
        let bounds = view.input_geometry.unwrap().0;
        point(bounds.center().x, bounds.bottom() - px(4.))
    });
    receiver.try_iter().for_each(drop);
    for position in [sidebar, terminal] {
        cx.simulate_keystrokes("f5");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let popup = cx.debug_bounds("commands-popover").unwrap();
        assert!(!popup.contains(&position));
        cx.simulate_mouse_down(position, MouseButton::Left, Modifiers::default());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.simulate_mouse_up(position, MouseButton::Left, Modifiers::default());
        view.read_with(cx, |view, _| {
            assert!(view.picker.is_none());
            assert!(view.input_interrupted);
            assert!(view.selection.is_none());
            assert_eq!(view.browser_request, 7);
        });
        assert!(receiver.try_recv().is_err());
    }
}

#[gpui::test]
fn command_popover_marked_composition_owns_escape_and_return(cx: &mut TestAppContext) {
    use gpui::EntityInputHandler;
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let search = view.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", None, window, cx);
            });
            assert!(search.read(cx).is_composing());
            // Test the owner while a composition is actually marked. The platform
            // input path may legitimately unmark it while consuming later keys.
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
                assert!(view.picker.is_some());
                assert!(search.read(cx).is_composing());
            }
        })
    });
    cx.simulate_keystrokes("escape enter");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker
                .as_ref()
                .is_some_and(|p| p.mode == Mode::Commands)
        );
        assert!(view.marked.is_empty());
        assert_eq!(view.browser_request, 7);
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn palette_paints_bezels_selected_row_and_lighter_scrim(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let row = cx.debug_bounds("picker-row-0").unwrap();
    let overlay = cx.debug_bounds("commands-overlay").unwrap();
    let theme = view.read_with(cx, |view, _| view.theme());
    let bezel = crate::tmux_snapshot::design::palette(&theme);
    let quads = cx.update(|window, _| (window.painted_quads(), window.scale_factor()));
    let (quads, scale) = quads;
    let at = |bounds: Bounds<Pixels>| {
        let scaled = bounds.scale(scale);
        quads
            .iter()
            .filter(move |quad| quad.bounds == scaled)
            .filter_map(|quad| quad.background.as_solid())
            .collect::<Vec<_>>()
    };
    // The selected row is Bezel's menu row wash.
    assert!(at(row).contains(&bezel.card_selected_bg()), "{:?}", at(row));
    // The card is an opaque plate, not glass: it floats over terminal output.
    let card = cx.debug_bounds("commands-popover").unwrap();
    let plate = crate::tmux_snapshot::design::popover_ink(&theme).plate;
    assert!(at(card).contains(&plate), "{:?}", at(card));
    assert_eq!(plate.a, 1.0);
    // The overlay dims with modal_glass's lighter scrim.
    assert!(
        at(overlay).contains(&bezel_theme::scrim(0.35)),
        "{:?}",
        at(overlay)
    );
}
