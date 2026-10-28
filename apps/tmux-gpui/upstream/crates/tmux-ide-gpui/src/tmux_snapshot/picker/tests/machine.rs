use super::*;

#[gpui::test]
fn machine_form_is_local_until_submit_and_escape_does_not_type(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("connect to machine");
    cx.simulate_keystrokes("enter");
    assert!(view.read_with(cx, |view, _| {
        view.picker
            .as_ref()
            .is_some_and(|p| p.mode == Mode::Machine)
    }));
    cx.simulate_input("spark");
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.picker.is_none()));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn machine_submit_uses_typed_target_and_retires_terminal_selection(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker_mode(Mode::Machine, window, cx)
        })
    });
    cx.simulate_input("user@spark");
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Machine { request: 8, ssh_target: Some(target) } if target == "user@spark")
    );
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert_eq!(view.browser_state.surface, browser::Surface::Home);
        assert!(!view.browser_state.input_ready);
        assert!(view.browser_state.selected_session.is_none());
        assert!(view.last_workspace_session.is_none());
    });
}

#[gpui::test]
fn invalid_or_stale_machine_form_never_emits_a_command(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker_mode(Mode::Machine, window, cx)
        })
    });
    cx.simulate_input("-invalid");
    cx.simulate_keystrokes("enter");
    assert!(view.read_with(cx, |view, _| view.picker.as_ref().unwrap().error.is_some()));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.picker
                .as_ref()
                .unwrap()
                .search
                .update(cx, |input, cx| input.set_text_selected("spark", cx));
            view.browser_request += 1;
            view.submit_machine(window, cx);
        })
    });
    assert!(receiver.try_recv().is_err());
}
