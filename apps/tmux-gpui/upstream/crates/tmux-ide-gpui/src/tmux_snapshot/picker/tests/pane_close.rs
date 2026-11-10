use super::*;
#[gpui::test]
fn close_requires_confirmation_cancel_is_inert_and_pointer_dispatches_once(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready_pane(view, false));
        window.draw(cx).clear(cx);
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    // The palette's row opens the card and makes way for it (c1).
    cx.simulate_keystrokes("f5");
    cx.simulate_input("close pane");
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert!(view.pane_close.is_some());
    });
    cx.simulate_keystrokes("escape");
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| assert!(view.pane_close.is_none()));
    cx.simulate_keystrokes("f5");
    cx.simulate_input("close pane");
    cx.simulate_keystrokes("enter");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let button = cx.debug_bounds("pane-close-confirm").unwrap();
    assert!(
        button.left() >= px(0.)
            && button.right() <= px(640.)
            && button.top() >= px(0.)
            && button.bottom() <= px(400.)
    );
    cx.simulate_click(button.center(), Modifiers::default());
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"pane-action","action":"close","request":7,"id":"pane-a","token":"312b2c16-a13d-4411-82e5-1fdb58adab92"})
    );
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert!(view.input_interrupted);
        assert_eq!(view.browser_request, 7);
        assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-a"));
    });
}
#[gpui::test]
fn close_reopen_stale_background_and_full_queue_refuse(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready_pane(view, false);
            let target =
                crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
            // The card never opens over the palette (c1).
            view.open_commands(window, cx);
            view.begin_pane_close(target.clone(), window, cx);
            assert!(view.pane_close.is_none());
            view.close_picker(window, cx);
            view.begin_pane_close(target.clone(), window, cx);
            assert!(receiver.try_recv().is_err());
            let old = view.pane_close.as_ref().unwrap().identity.clone();
            view.cancel_pane_close(window, cx);
            view.begin_pane_close(target, window, cx);
            view.confirm_pane_close(&old, window, cx);
            assert!(receiver.try_recv().is_err());
            let current = view.pane_close.as_ref().unwrap().identity.clone();
            view.presence.set_active(false);
            view.confirm_pane_close(&current, window, cx);
            assert!(receiver.try_recv().is_err());
            view.presence = Presence::new(true);
            view.presence.flush(view.browser_commands.as_ref().unwrap());
            receiver.try_iter().for_each(drop);
            view.presence.acknowledge(1);
            view.browser_state.pane_actions.as_mut().unwrap().token = "replacement".into();
            view.confirm_pane_close(&current, window, cx);
            assert!(receiver.try_recv().is_err());
            ready_pane(view, false);
            // A full queue: the card stays, says so, and sends nothing.
            view.browser_commands
                .as_ref()
                .unwrap()
                .try_send(browser::Command::Home { request: 99 })
                .unwrap();
            view.confirm_pane_close(&current, window, cx);
            assert!(view.pane_close.as_ref().unwrap().error.is_some());
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::Home { request: 99 }
            ));
            assert!(receiver.try_recv().is_err());
            assert!(view.browser_state.pane_actions.is_some());
            view.confirm_pane_close(&current, window, cx);
            receiver.try_recv().unwrap();
            view.confirm_pane_close(&current, window, cx);
            assert!(receiver.try_recv().is_err());
            assert!(view.input_interrupted);
        })
    });
}
