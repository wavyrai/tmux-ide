use super::*;
#[gpui::test]
fn sidebar_toggle_changes_only_layout_and_retains_preference(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.surface = browser::Surface::Workspace;
            v.browser_state.request = v.browser_request;
            v.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    let before = view.read_with(cx, |v, _| v.input_geometry.unwrap().0.size.width);
    cx.simulate_keystrokes("f10");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |v, _| {
        assert!(v.sidebar_hidden);
        assert_eq!(v.input_geometry.unwrap().0.size.width, before + px(224.));
        assert_eq!(v.browser_state.selected_pane.as_deref(), Some("pane-a"));
        assert!(v.input_interrupted);
        assert_eq!(v.browser_request, 7);
    });
    assert!(receiver.try_iter().all(|c| matches!(
        c,
        browser::Command::Input {
            input: crate::tmux_snapshot::keys::Input::Resize { .. },
            ..
        }
    )));
    cx.simulate_keystrokes("f5");
    cx.simulate_input("show sidebar");
    cx.simulate_keystrokes("enter");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(!view.read_with(cx, |v, _| v.sidebar_hidden));
    let button = cx.debug_bounds("sidebar-toggle").unwrap();
    cx.simulate_click(button.center(), Modifiers::default());
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            assert!(v.sidebar_hidden);
            v.browser_state.surface = browser::Surface::Home;
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        view.update(cx, |v, _| {
            assert!(v.sidebar_hidden);
            v.browser_state.surface = browser::Surface::Workspace;
        });
    });
    assert!(view.read_with(cx, |v, _| v.sidebar_hidden));
}
#[gpui::test]
fn sidebar_shortcut_ignores_modal_modifiers_and_held_keys(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            for key in ["shift-f10", "ctrl-f10", "alt-f10", "cmd-f10"] {
                v.picker_key(
                    &crate::tmux_snapshot::fit_test_support::key_down(key),
                    window,
                    cx,
                );
                assert!(!v.sidebar_hidden);
            }
            v.picker_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("f10").unwrap(),
                    is_held: true,
                    prefer_character_input: false,
                    layout: None,
                },
                window,
                cx,
            );
            assert!(!v.sidebar_hidden);
            v.marked = "未".into();
            v.picker_key(
                &crate::tmux_snapshot::fit_test_support::key_down("f10"),
                window,
                cx,
            );
            assert!(!v.sidebar_hidden);
            assert_eq!(v.marked, "未");
            v.marked.clear();
            v.open_commands(window, cx);
            v.picker_key(
                &crate::tmux_snapshot::fit_test_support::key_down("f10"),
                window,
                cx,
            );
            assert!(!v.sidebar_hidden);
        })
    });
}

#[gpui::test]
fn stale_sidebar_row_cannot_replace_an_agent_form(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = v.browser_request;
            v.browser_state.surface = browser::Surface::Workspace;
            v.browser_state.selected_session = Some("session-a".into());
            v.browser_state.pane_actions = Some(browser::PaneActions {
                token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
            v.open_commands(window, cx);
            let stale = command_rows(&v.browser_state, "hide sidebar")
                .remove(0)
                .target;
            let target =
                crate::tmux_snapshot::pane_actions::Target::capture(&v.browser_state).unwrap();
            v.begin_new_agent(target, window, cx);
            v.choose_picker(stale, window, cx);
            assert!(!v.sidebar_hidden);
            assert!(v.picker.as_ref().unwrap().agent.is_some());
            assert!(receiver.try_recv().is_err());
        })
    });
}
