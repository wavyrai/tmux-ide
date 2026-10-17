use super::*;

#[gpui::test]
fn sidebar_keys_choose_duplicate_label_by_displayed_id_and_escape_keeps_latch(
    cx: &mut TestAppContext,
) {
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
    cx.simulate_keystrokes("ctrl-g down escape");
    cx.update(|window, cx| {
        view.read_with(cx, |view, _| {
            assert!(view.terminal_focus.is_focused(window));
            assert!(view.input_interrupted);
        })
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("ctrl-g down enter");
    let commands: Vec<_> = receiver.try_iter().collect();
    assert_eq!(commands.len(), 1);
    assert_eq!(
        serde_json::to_value(&commands[0]).unwrap(),
        serde_json::json!({"type":"session","request":8,"id":"session-b"})
    );
}

#[gpui::test]
fn sidebar_reorder_retains_id_but_removal_or_request_change_cannot_choose_replacement(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_state.request = 7);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down");
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_state.sessions.reverse());
        window.draw(cx).clear(cx);
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.sidebar_keyboard.selected.as_ref(),
                Some(&Target::Session("session-b".into()))
            )
        });
        // Remove after the last paint: Enter must not adopt another row.
        view.update(cx, |view, _| {
            view.browser_state.sessions.retain(|s| s.id != "session-b")
        });
    });
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_request = 8);
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("enter");
    let commands: Vec<_> = receiver.try_iter().collect();
    assert!(commands.iter().all(|command| matches!(command, browser::Command::Input { request: 8, id, input: crate::tmux_snapshot::keys::Input::Resize { .. } } if id == "pane-a")), "request redraw may only refresh geometry, never send a key or select a replacement");
    view.read_with(cx, |view, _| {
        assert!(!view.sidebar_keyboard.active);
        assert!(view.input_interrupted);
    });
}

#[gpui::test]
fn sidebar_end_reveals_long_roster_and_hidden_ctrl_g_uses_picker(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.request = 7;
            view.browser_state.sessions = (0..30)
                .map(|i| choice(&format!("s{i}"), "A very long duplicate session label"))
                .collect();
            view.browser_state.selected_session = Some("s0".into());
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g end");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let list = cx.debug_bounds("session-list").unwrap();
    let last = cx.debug_bounds("tmux-sidebar-row-29").unwrap();
    assert!(last.top() >= list.top() && last.bottom() <= list.bottom());
    cx.simulate_keystrokes("home pagedown pageup escape");
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.sidebar_hidden = true);
        window.draw(cx).clear(cx);
    });
    let resize_commands: Vec<_> = receiver.try_iter().collect();
    assert!(!resize_commands.is_empty());
    assert!(
        resize_commands.iter().all(|command| matches!(
            command,
            browser::Command::Input {
                input: crate::tmux_snapshot::keys::Input::Resize { .. },
                ..
            }
        )),
        "hide may only resize the existing terminal"
    );
    cx.simulate_keystrokes("ctrl-g");
    view.read_with(cx, |view, _| assert!(view.picker.is_some()));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn sidebar_entry_and_activation_refuse_composition_background_and_full_queue(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.request = 7;
            view.marked = "界".into();
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g");
    view.read_with(cx, |view, _| {
        assert!(!view.sidebar_keyboard.active);
        assert_eq!(view.marked, "界");
    });
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| view.update(cx, |view, _| view.marked.clear()));
    cx.simulate_keystrokes("ctrl-g down");
    cx.update(|_, cx| view.update(cx, |view, _| view.presence.set_active(false)));
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| assert!(!view.sidebar_keyboard.active));
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let mut presence = Presence::new(true);
            presence.flush(view.browser_commands.as_ref().unwrap());
            presence.acknowledge(1);
            view.presence = presence;
        })
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down");
    let (full, _queued) = mpsc::sync_channel(0);
    cx.update(|_, cx| view.update(cx, |view, _| view.browser_commands = Some(full)));
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(!view.sidebar_keyboard.active);
        assert!(view.browser_commands.is_none());
        assert!(!view.browser_state.input_ready);
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn sidebar_empty_selection_starts_first_and_repeated_movement_stays_local(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.request = 7;
            view.browser_state.selected_session = None;
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down");
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.sidebar_keyboard.selected.as_ref(),
            Some(&Target::Session("session-a".into()))
        )
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            for (key, expected) in [
                ("down", "session-b"),
                ("enter", "session-b"),
                ("ctrl-g", "session-b"),
            ] {
                view.sidebar_keyboard_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: true,
                        prefer_character_input: false,
                        layout: None,
                    },
                    window,
                    cx,
                );
                assert_eq!(
                    view.sidebar_keyboard.selected.as_ref(),
                    Some(&Target::Session(expected.into()))
                );
            }
        })
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("f6");
    view.read_with(cx, |view, _| {
        assert!(!view.sidebar_keyboard.active);
        assert!(view.picker.is_some());
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn sidebar_keeps_platform_navigation_and_modal_ownership(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_state.request = 7);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g cmd-k");
    view.read_with(cx, |view, _| {
        assert!(!view.sidebar_keyboard.active);
        assert!(view.picker.is_some());
    });
    cx.simulate_input("session");
    cx.simulate_keystrokes("ctrl-g");
    view.read_with(cx, |view, _| assert!(!view.sidebar_keyboard.active));
    assert!(receiver.try_recv().is_err());
}
