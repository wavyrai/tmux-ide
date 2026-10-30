use super::*;
#[gpui::test]
fn f5_pane_actions_dispatch_existing_wire_without_navigation_or_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    // Establish the same ready Workspace chrome before measuring its viewport.
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready_pane(view, false));
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    for (query, zoomed, expected) in [
        (
            "new terminal window",
            false,
            serde_json::json!({"action":"new-window"}),
        ),
        (
            "zoom pane",
            false,
            serde_json::json!({"action":"zoom","desired":"zoomed"}),
        ),
        (
            "unzoom pane",
            true,
            serde_json::json!({"action":"zoom","desired":"unzoomed"}),
        ),
        (
            "split right",
            false,
            serde_json::json!({"action":"split","direction":"right"}),
        ),
        (
            "split down",
            false,
            serde_json::json!({"action":"split","direction":"down"}),
        ),
    ] {
        cx.update(|_, cx| view.update(cx, |view, _| ready_pane(view, zoomed)));
        let canvas_before = view.read_with(cx, |view, _| view.input_geometry.unwrap().0);
        cx.simulate_keystrokes("f5");
        cx.simulate_input(query);
        cx.simulate_keystrokes("enter");
        let mut expected = expected;
        let object = expected.as_object_mut().unwrap();
        object.insert("type".into(), "pane-action".into());
        object.insert("request".into(), 7.into());
        object.insert("id".into(), "pane-a".into());
        object.insert(
            "token".into(),
            "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
        );
        assert_eq!(
            serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
            expected
        );
        assert!(receiver.try_recv().is_err());
        view.read_with(cx, |view, _| {
            assert_eq!(view.input_geometry.unwrap().0, canvas_before);
            assert!(view.picker.is_none());
            assert!(view.browser_state.pane_actions.is_none());
            assert!(view.input_interrupted);
            assert_eq!(view.browser_request, 7);
            assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-a"));
        });
    }
}
#[gpui::test]
fn f5_pane_action_captured_token_and_disabled_state_are_inert(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready_pane(view, false);
            view.open_commands(window, cx);
            let target = command_rows(&view.browser_state, "split right")
                .remove(0)
                .target;
            view.browser_state.pane_actions.as_mut().unwrap().token = "replacement".into();
            view.choose_picker(target, window, cx);
            assert!(view.picker.is_some());
            assert!(view.browser_state.pane_actions.is_some());
            view.browser_state.input_ready = false;
            let disabled = command_rows(&view.browser_state, "split right")
                .remove(0)
                .target;
            assert!(!current(&view.browser_state, &disabled));
            view.choose_picker(disabled, window, cx);
            assert!(view.picker.is_some());
            assert!(view.input_interrupted);
        })
    });
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn f5_pane_action_full_queue_preserves_picker_and_capability(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready_pane(view, false);
            view.open_commands(window, cx);
            view.browser_commands
                .as_ref()
                .unwrap()
                .try_send(browser::Command::PaneAction {
                    request: 7,
                    id: "occupied".into(),
                    token: "occupied".into(),
                    action: crate::tmux_snapshot::pane_actions::Action::Split {
                        direction: crate::tmux_snapshot::pane_actions::SplitDirection::Right,
                    },
                })
                .unwrap();
            let target = command_rows(&view.browser_state, "split down")
                .remove(0)
                .target;
            view.choose_picker(target, window, cx);
            assert!(view.picker.as_ref().unwrap().error.is_some());
            assert!(view.browser_state.pane_actions.is_some());
            assert!(view.input_interrupted);
        })
    });
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::PaneAction{id,..} if id=="occupied")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn old_f5_pane_action_cannot_dispatch_through_replacement_picker(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready_pane(view, false);
            for mode in [Mode::Theme, Mode::Navigation, Mode::Machine] {
                view.open_commands(window, cx);
                let target = command_rows(&view.browser_state, "split right")
                    .remove(0)
                    .target;
                view.picker.as_mut().unwrap().mode = mode;
                view.choose_picker(target, window, cx);
                assert!(view.picker.as_ref().unwrap().mode == mode);
                assert!(view.browser_state.pane_actions.is_some());
                assert!(view.input_interrupted);
            }
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn new_window_strip_click_is_bounded_and_consumes_only_captured_capability(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            ready_pane(view, false);
            for index in 0..12 {
                let mut pane = view.browser_state.panes[0].clone();
                pane.id = format!("extra-{index}");
                pane.window_id = Some(format!("window-{index}"));
                pane.window_label = Some("A long window name for overflow".into());
                view.browser_state.panes.push(pane);
            }
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    // Finish the fixture resize before testing one-use capability dispatch.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let bounds = cx.debug_bounds("workspace-new-window").unwrap();
    assert!(bounds.left() >= px(0.) && bounds.right() <= px(640.) && bounds.bottom() <= px(400.));
    let geometry = view.read_with(cx, |view, _| view.input_geometry.unwrap().0);
    cx.simulate_click(bounds.center(), Modifiers::default());
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"pane-action","action":"new-window","request":7,"id":"pane-a","token":"312b2c16-a13d-4411-82e5-1fdb58adab92"})
    );
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_click(bounds.center(), Modifiers::default());
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        assert_eq!(view.input_geometry.unwrap().0, geometry);
        assert_eq!(view.browser_request, 7);
        assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-a"));
        assert!(view.input_interrupted);
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready_pane(view, false);
            let old =
                crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
            view.browser_state.pane_actions.as_mut().unwrap().token = "replacement".into();
            view.create_window_from_strip(&old, window, cx);
            assert!(view.picker.is_none());
            assert!(receiver.try_recv().is_err());
            let current =
                crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
            view.open_commands(window, cx);
            view.create_window_from_strip(&current, window, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}

#[gpui::test]
fn new_window_strip_full_queue_preserves_capability_and_shows_error(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            ready_pane(view, false);
            let target =
                crate::tmux_snapshot::pane_actions::Target::capture(&view.browser_state).unwrap();
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
            view.create_window_from_strip(&target, window, cx);
            assert!(view.browser_state.pane_actions.is_some());
            assert!(view.picker.as_ref().unwrap().error.is_some());
            assert!(view.input_interrupted);
            assert_eq!(view.browser_request, 7);
        })
    });
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::PaneAction{id,..} if id=="occupied")
    );
    assert!(receiver.try_recv().is_err());
}
