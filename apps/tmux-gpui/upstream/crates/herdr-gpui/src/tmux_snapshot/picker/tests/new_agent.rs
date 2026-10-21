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
fn agent_form_keyboard_pointer_cancel_and_narrow_geometry(cx: &mut TestAppContext) {
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
    cx.simulate_input("new agent");
    cx.simulate_keystrokes("enter");
    cx.simulate_input("Cancelled");
    cx.simulate_keystrokes("escape");
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("f5");
    cx.simulate_input("new agent");
    cx.simulate_keystrokes("enter");
    cx.simulate_input("Agent name");
    cx.simulate_keystrokes("tab");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let button = cx.debug_bounds("new-agent-submit").unwrap();
    assert!(button.left() >= px(0.) && button.right() <= px(640.) && button.bottom() <= px(400.));
    cx.simulate_click(button.center(), Modifiers::default());
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"pane-action","action":"new-agent","request":7,"id":"pane-a","token":"312b2c16-a13d-4411-82e5-1fdb58adab92","name":"Agent name","harness":"codex"})
    );
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| {
        assert!(v.input_interrupted);
        assert_eq!(v.browser_request, 7);
        assert_eq!(v.browser_state.selected_pane.as_deref(), Some("pane-a"));
    });
}
#[gpui::test]
fn agent_form_identity_composition_stale_and_queue_fences(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready(view);
            view.open_commands(window, cx);
            let target =
                crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
            let stale_row = command_rows(&view.browser_state, "new terminal window")
                .remove(0)
                .target;
            view.begin_new_agent(target.clone(), window, cx);
            let old = view
                .picker
                .as_ref()
                .unwrap()
                .agent
                .as_ref()
                .unwrap()
                .identity
                .clone();
            view.close_picker(window, cx);
            view.open_commands(window, cx);
            view.begin_new_agent(target, window, cx);
            view.choose_picker(stale_row, window, cx);
            assert!(receiver.try_recv().is_err());
            let f = view.picker.as_ref().unwrap().agent.as_ref().unwrap();
            let identity = f.identity.clone();
            let name = f.name.clone();
            name.update(cx, |name, cx| name.set_text_selected("Agent", cx));
            view.submit_new_agent(&old, window, cx);
            assert!(receiver.try_recv().is_err());
            name.update(cx, |name, cx| {
                name.replace_and_mark_text_in_range(None, "界", None, window, cx)
            });
            for key in ["enter", "tab", "escape"] {
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
                assert!(view.picker.as_ref().unwrap().agent.is_some());
                assert!(receiver.try_recv().is_err());
            }
            name.update(cx, |name, cx| {
                name.unmark_text(window, cx);
                name.set_text_selected("Agent", cx);
            });
            view.browser_state.pane_actions.as_mut().unwrap().token = "replacement".into();
            view.submit_new_agent(&identity, window, cx);
            assert!(receiver.try_recv().is_err());
            ready(view);
            view.browser_commands
                .as_ref()
                .unwrap()
                .try_send(browser::Command::PaneAction {
                    request: 7,
                    id: "occupied".into(),
                    token: "occupied".into(),
                    action: crate::tmux_snapshot::pane_actions::Action::NewWindow,
                })
                .unwrap();
            view.submit_new_agent(&identity, window, cx);
            assert!(view.picker.as_ref().unwrap().error.is_some());
            assert!(view.browser_state.pane_actions.is_some());
            receiver.try_recv().unwrap();
            view.submit_new_agent(&identity, window, cx);
            receiver.try_recv().unwrap();
            view.submit_new_agent(&identity, window, cx);
            assert!(receiver.try_recv().is_err());
            assert!(view.input_interrupted);
        })
    });
}
