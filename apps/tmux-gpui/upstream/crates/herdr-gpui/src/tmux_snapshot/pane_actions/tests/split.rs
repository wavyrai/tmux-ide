use super::*;

#[gpui::test]
fn rendered_split_choices_queue_exact_target_once_without_input_or_navigation(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(600.)));
    // Establish ordinary viewport geometry before the modal suppresses resizing.
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    for (selector, direction) in [
        ("pane-action-split-right", "right"),
        ("pane-action-split-down", "down"),
    ] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.browser_state.pane_actions = Some(browser::PaneActions {
                    token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                    id: "pane-a".into(),
                    zoomed: false,
                });
                view.input_interrupted = true;
                view.open_pane_actions(window, cx);
            });
            window.draw(cx).clear(cx);
        });
        receiver.try_iter().for_each(drop);
        let canvas_before = view.read_with(cx, |view, _| view.input_geometry.unwrap().0);
        let button = cx.debug_bounds(selector).unwrap();
        cx.simulate_click(button.center(), Modifiers::default());
        assert_eq!(
            serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
            serde_json::json!({"type":"pane-action","request":7,"id":"pane-a","token":"312b2c16-a13d-4411-82e5-1fdb58adab92","action":"split","direction":direction})
        );
        view.read_with(cx, |view, _| {
            assert!(view.pane_actions.is_none());
            assert!(view.browser_state.pane_actions.is_none());
            assert_eq!(view.browser_request, 7);
            assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-a"));
            assert!(view.input_interrupted);
            assert_eq!(view.input_geometry.unwrap().0, canvas_before);
        });
        let extra: Vec<_> = receiver
            .try_iter()
            .map(|command| serde_json::to_value(command).unwrap())
            .collect();
        assert!(extra.is_empty(), "unexpected commands: {extra:?}");
    }
}
#[gpui::test]
fn split_revalidates_captured_capability_and_queue_failure_keeps_menu(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        let original = view.browser_state.clone();
        for case in 0..4 {
            view.browser_state = original.clone(); view.browser_request = 7;
            view.open_pane_actions(window, cx);
            match case {
                0 => view.browser_request = 8,
                1 => view.browser_state.selected_session = Some("other".into()),
                2 => view.browser_state.pane_actions.as_mut().unwrap().token = "new-token".into(),
                _ => view.browser_state.input_ready = false,
            }
            view.split_pane(SplitDirection::Right, window, cx);
            assert!(receiver.try_recv().is_err()); assert!(view.pane_actions.is_none());
        }
        view.browser_state = original; view.browser_request = 7;
        view.open_pane_actions(window, cx);
        view.browser_commands.as_ref().unwrap().try_send(browser::Command::PaneAction { request:7,id:"occupied".into(),token:"occupied".into(),action:Action::Split{direction:SplitDirection::Down} }).unwrap();
        view.split_pane(SplitDirection::Down, window, cx);
        assert!(view.pane_actions.as_ref().unwrap().error.is_some());
        assert!(view.browser_state.pane_actions.is_some());
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::PaneAction{id,..} if id=="occupied"));
        assert!(receiver.try_recv().is_err());
    }));
}
