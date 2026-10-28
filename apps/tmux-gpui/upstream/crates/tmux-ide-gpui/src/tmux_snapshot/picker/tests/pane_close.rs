use super::*;
fn ready(view: &mut SnapshotView) {
    view.browser_state.surface = browser::Surface::Workspace;
    view.browser_state.request = view.browser_request;
    view.browser_state.selected_session = Some("session-a".into());
    view.browser_state.pane_actions = Some(browser::PaneActions {
        token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
        id: "pane-a".into(),
        zoomed: false,
    });
    view.input_interrupted = true;
}
#[gpui::test]
fn close_requires_confirmation_cancel_is_inert_and_pointer_dispatches_once(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready(view));
        window.draw(cx).clear(cx);
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("close pane");
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    assert!(receiver.try_recv().is_err());
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
    cx.update(|window,cx| view.update(cx, |view,cx| {
        ready(view);
        view.open_commands(window,cx);
        let stale_row = command_rows(&view.browser_state, "new terminal window").remove(0).target;
        let target=crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
        view.begin_pane_close(target.clone(),window,cx);
        view.choose_picker(stale_row, window, cx);
        assert!(receiver.try_recv().is_err());
        assert!(view.picker.as_ref().unwrap().closing.is_some());
        let old=view.picker.as_ref().unwrap().closing.as_ref().unwrap().identity.clone();
        view.close_picker(window,cx); view.open_commands(window,cx); view.begin_pane_close(target,window,cx);
        view.confirm_pane_close(&old,window,cx); assert!(receiver.try_recv().is_err());
        let current=view.picker.as_ref().unwrap().closing.as_ref().unwrap().identity.clone();
        view.presence.set_active(false); view.confirm_pane_close(&current,window,cx); assert!(receiver.try_recv().is_err());
        view.presence = Presence::new(true); view.presence.flush(view.browser_commands.as_ref().unwrap()); receiver.try_iter().for_each(drop); view.presence.acknowledge(1);
        view.browser_state.pane_actions.as_mut().unwrap().token="replacement".into();
        view.confirm_pane_close(&current,window,cx); assert!(receiver.try_recv().is_err());
        ready(view);
        view.browser_commands.as_ref().unwrap().try_send(browser::Command::PaneAction {request:7,id:"occupied".into(),token:"occupied".into(),action:crate::tmux_snapshot::pane_actions::Action::Close}).unwrap();
        view.confirm_pane_close(&current,window,cx); assert!(view.picker.as_ref().unwrap().error.is_some()); assert!(view.browser_state.pane_actions.is_some());
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::PaneAction{id,..} if id=="occupied"));
        view.confirm_pane_close(&current,window,cx); receiver.try_recv().unwrap();
        view.confirm_pane_close(&current,window,cx); assert!(receiver.try_recv().is_err());
        assert!(view.input_interrupted);
    }));
}
