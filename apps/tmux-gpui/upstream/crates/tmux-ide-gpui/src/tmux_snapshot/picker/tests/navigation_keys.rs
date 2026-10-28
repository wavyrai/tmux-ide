use super::*;

#[test]
fn only_unmodified_application_function_keys_are_reserved() {
    for key in ["f1", "f2", "f5", "f6", "f7"] {
        assert!(super::super::commands::shortcut(
            &Keystroke::parse(key).unwrap()
        ));
        for modifier in ["shift", "ctrl", "alt", "cmd"] {
            assert!(!super::super::commands::shortcut(
                &Keystroke::parse(&format!("{modifier}-{key}")).unwrap()
            ));
        }
    }
    assert!(!super::super::commands::shortcut(
        &Keystroke::parse("f3").unwrap()
    ));
}

#[gpui::test]
fn home_and_terminals_keys_use_the_same_current_session_route_as_tabs(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f1");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Home { request: 8 }
    ));
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.browser_state.home_phase = browser::HomePhase::Live;
            view.browser_state.sessions = vec![choice("session-a", "Alpha")];
            view.last_workspace_session = Some("session-a".into());
        })
    });
    cx.simulate_keystrokes("f2");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Session { request: 9, id } if id == "session-a")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn sessions_key_opens_search_without_forwarding_function_key_to_terminal(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f6");
    assert!(view.read_with(cx, |view, _| {
        view.picker
            .as_ref()
            .is_some_and(|p| p.mode == Mode::Navigation)
    }));
    cx.simulate_input("Alpha");
    cx.simulate_keystrokes("escape");
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn terminals_key_closes_command_search_when_workspace_already_selected(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.surface = browser::Surface::Workspace
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    for mode in [Mode::Commands, Mode::Navigation, Mode::Machine] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.input_interrupted = true;
                view.open_picker_mode(mode, window, cx);
            })
        });
        cx.simulate_keystrokes("f2");
        cx.update(|window, cx| {
            view.update(cx, |view, _| {
                assert!(view.picker.is_none());
                assert!(view.terminal_focus.is_focused(window));
                assert!(view.input_interrupted);
            })
        });
        assert!(receiver.try_recv().is_err());
    }
}
