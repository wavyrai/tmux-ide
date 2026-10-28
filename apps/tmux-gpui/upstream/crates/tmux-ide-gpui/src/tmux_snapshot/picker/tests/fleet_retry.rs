use super::*;

#[gpui::test]
fn f5_retry_uses_current_token_without_navigation_or_registry_mutation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    let token = "fe470cdc-82bb-48d5-8fc4-1fa68025c8e4";
    let fleet = serde_json::json!({ "groups": [{ "id": "remote", "label": "Build host",
        "state": "disconnected", "conflict": false, "retry": token,
        "omittedSessions": 0, "sessions": [] }], "omittedGroups": 0 });
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.fleet = Some(serde_json::from_value(fleet).unwrap())
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("retry build");
    view.read_with(cx, |view, _| {
        assert_eq!(view.picker.as_ref().unwrap().rows.len(), 1)
    });
    cx.simulate_keystrokes("enter");
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"fleet-retry", "request":7, "retry":token})
    );
    view.read_with(cx, |view, _| {
        assert_eq!(view.browser_request, 7);
        assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-a"));
        assert!(view.picker.is_none());
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.retry_fleet_machine(6, token, window, cx);
            view.browser_state.fleet.as_mut().unwrap().groups[0].retry = None;
            view.retry_fleet_machine(7, token, window, cx);
        })
    });
    assert!(
        receiver.try_recv().is_err(),
        "stale actions must not issue retry, navigation or registry writes"
    );
}

#[gpui::test]
fn fleet_retry_full_queue_keeps_f5_error_visible_and_home_uses_same_feedback(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let queued = sender.clone();
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    let token = "fe470cdc-82bb-48d5-8fc4-1fa68025c8e4";
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.fleet = Some(serde_json::from_value(serde_json::json!({
            "groups":[{"id":"remote","label":"Build", "state":"disconnected", "conflict":false,
                "retry":token,"omittedSessions":0,"sessions":[]}], "omittedGroups":0
        })).unwrap());
            queued
                .try_send(browser::Command::Home { request: 99 })
                .unwrap();
            assert!(!view.retry_fleet_machine(7, token, window, cx));
            assert!(view.picker.as_ref().unwrap().error.is_some());
            view.choose_picker(Target::FleetRetry(token.into()), window, cx);
            assert!(view.picker.as_ref().unwrap().error.is_some());
            assert_eq!(view.browser_request, 7);
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Home { request: 99 }
    ));
    assert!(receiver.try_recv().is_err());
}
