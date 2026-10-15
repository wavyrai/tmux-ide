use super::*;

#[gpui::test]
fn chrome_tab_is_opt_in_skips_unavailable_controls_and_refreshes_once(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_state.request = 7);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("tab");
    view.read_with(cx, |view, _| assert!(!view.sidebar_keyboard.active));
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Input {
        request: 7, input: crate::tmux_snapshot::keys::Input::Key(key), ..
    } if key == "Tab")
    );
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("ctrl-g tab tab");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert!(view.sidebar_keyboard.controls.as_ref().unwrap()[2].is_focused(window));
        });
    });
    cx.simulate_keystrokes("shift-tab");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert!(view.sidebar_keyboard.controls.as_ref().unwrap()[0].is_focused(window));
        });
    });
    cx.simulate_keystrokes("tab enter");
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    let commands: Vec<_> = receiver.try_iter().collect();
    assert_eq!(commands.len(), 1);
    assert_eq!(
        serde_json::to_value(&commands[0]).unwrap(),
        serde_json::json!({"type":"refresh","request":8})
    );
}

#[gpui::test]
fn chrome_focus_wraps_and_hiding_sidebar_retires_it(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.request = 7;
            view.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    // No window capability exists: reverse traversal reaches Toggle, not Plus.
    cx.simulate_keystrokes("ctrl-g shift-tab");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert!(view.sidebar_keyboard.controls.as_ref().unwrap()[3].is_focused(window));
        });
    });
    cx.simulate_keystrokes("tab");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert!(
                view.sidebar_keyboard
                    .focus
                    .as_ref()
                    .unwrap()
                    .is_focused(window)
            );
        });
    });
    let width_before = view.read_with(cx, |view, _| view.input_geometry.unwrap().0.size.width);
    cx.simulate_keystrokes("shift-tab space");
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("space").unwrap(),
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, _| {
            assert!(view.sidebar_hidden);
            assert_eq!(
                view.input_geometry.unwrap().0.size.width,
                width_before + px(224.)
            );
            assert!(!view.sidebar_keyboard.active);
            assert!(view.terminal_focus.is_focused(window));
            assert!(view.input_interrupted);
        });
    });
    let commands: Vec<_> = receiver.try_iter().collect();
    assert_eq!(commands.len(), 1);
    assert!(
        matches!(&commands[0], browser::Command::Input {
        request: 7, id, input: crate::tmux_snapshot::keys::Input::Resize { cols, rows },
    } if id == "pane-a" && *cols > 0 && *rows > 0),
        "hiding the sidebar may resize the same pane, never send a key or select a session"
    );
}

#[gpui::test]
fn stale_control_keyup_does_not_refresh_or_select_a_session(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_state.request = 7);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g tab tab enter");
    cx.update(|_, cx| view.update(cx, |view, _| view.browser_request += 1));
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, _| {
            assert!(!view.sidebar_keyboard.active);
            assert!(view.terminal_focus.is_focused(window));
        });
    });
}

#[gpui::test]
fn available_plus_activates_once_and_lost_capability_returns_to_rows(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.request = 7;
            view.browser_state.pane_actions = Some(browser::PaneActions {
                token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g shift-tab enter");
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction {
            request: 7,
            action: crate::tmux_snapshot::pane_actions::Action::NewWindow,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
    // Dispatch consumes the one-use capability and returns terminal focus.
    // Publish a fresh capability before testing loss on a focused Plus.
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.pane_actions = Some(browser::PaneActions {
                token: "412b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("ctrl-g shift-tab");
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            assert!(view.sidebar_keyboard.controls.as_ref().unwrap()[4].is_focused(window));
            view.browser_state.pane_actions = None;
        });
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, _| {
            assert!(
                view.sidebar_keyboard
                    .focus
                    .as_ref()
                    .unwrap()
                    .is_focused(window)
            );
        });
    });
}

#[gpui::test]
fn modal_between_control_keydown_and_keyup_preserves_picker_and_blocks_refresh(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_state.request = 7);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g tab tab enter");
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_picker(window, cx)));
    cx.simulate_event(KeyUpEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, _| {
            assert!(view.picker.is_some());
            assert!(!view.terminal_focus.is_focused(window));
        });
    });
}

#[gpui::test]
fn pointer_refresh_remains_available_while_terminal_presence_is_pending(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.request = 7;
            view.presence = Presence::new(true);
            assert!(!view.presence.ready());
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let bounds = cx.debug_bounds("refresh-sessions").unwrap();
    cx.simulate_click(bounds.center(), Modifiers::default());
    let commands: Vec<_> = receiver.try_iter().collect();
    assert_eq!(commands.len(), 1);
    assert_eq!(
        serde_json::to_value(&commands[0]).unwrap(),
        serde_json::json!({"type":"refresh","request":8})
    );
}

#[gpui::test]
fn chrome_escape_and_home_navigation_retire_control_focus(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.input_interrupted = true);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g tab escape");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert!(!view.sidebar_keyboard.active);
            assert!(view.terminal_focus.is_focused(window));
            assert!(view.input_interrupted);
        });
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("ctrl-g tab f1");
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, _| {
            assert_eq!(view.browser_state.surface, browser::Surface::Home);
            assert!(!view.sidebar_keyboard.active);
            assert!(view.terminal_focus.is_focused(window));
        });
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Home { request: 8 }
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn lost_theme_readiness_returns_chrome_focus_to_rows(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.appearance = Some(
                serde_json::from_value(serde_json::json!({
                    "selected":"dark", "system":"dark", "error":null,
                    "theme":{"canvas":1,"background":2,"foreground":3,"cursor":4,"surface":5,
                        "active":6,"muted":7,"accent":8,"palette":vec![9;256]},
                    "options":[{"id":"dark","name":"Dark"}]
                }))
                .unwrap(),
            );
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g tab tab");
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            assert!(view.sidebar_keyboard.controls.as_ref().unwrap()[1].is_focused(window));
            view.browser_state.appearance = None;
        });
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, _| {
            assert!(
                view.sidebar_keyboard
                    .focus
                    .as_ref()
                    .unwrap()
                    .is_focused(window)
            );
            assert!(view.sidebar_keyboard.active);
        });
    });
    assert!(receiver.try_recv().is_err());
}
