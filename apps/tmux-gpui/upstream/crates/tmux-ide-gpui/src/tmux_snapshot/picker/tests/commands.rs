use super::*;

#[gpui::test]
fn f5_search_and_escape_never_send_terminal_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker
                .as_ref()
                .is_some_and(|p| p.mode == Mode::Commands)
        );
    });
    cx.simulate_input("switch session");
    view.read_with(cx, |view, _| {
        let picker = view.picker.as_ref().unwrap();
        assert_eq!(picker.rows.len(), 1);
        assert_eq!(picker.rows[0].target, Target::Command(Action::Sessions));
    });
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker
                .as_ref()
                .is_some_and(|p| p.mode == Mode::Navigation)
        );
    });
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.picker.is_none()));
    assert!(
        receiver.try_recv().is_err(),
        "local command search must not type into tmux"
    );
}

#[gpui::test]
fn command_from_replaced_request_is_inert(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_commands(window, cx);
            view.browser_request += 1;
            view.choose_picker(Target::Command(Action::Refresh), window, cx);
            assert!(view.picker.is_some());
        })
    });
    assert!(receiver.try_recv().is_err());
}
