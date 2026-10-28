use super::*;
const ID: &str = "00000000-0000-4000-8000-000000000001";
fn registry() -> browser::machines::Registry {
    serde_json::from_value(serde_json::json!({
        "revision": 12, "available": true, "pending": false,
        "error": null, "message": null,
        "machines": [{"id": ID, "label": "Build host", "sshTarget": "demo@spark", "enabled": true}]
    }))
    .unwrap()
}
fn disable() -> Target {
    Target::MachineToggle {
        id: ID.into(),
        revision: 12,
        enabled: false,
    }
}
#[gpui::test]
fn manage_machine_keyboard_uses_captured_identity_without_terminal_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, _| v.browser_state.machines = Some(registry()));
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("manage saved machines");
    cx.simulate_keystrokes("enter");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Machines {
            operation: browser::machines::Operation::Read,
            ..
        }
    ));
    cx.simulate_input("disable build");
    cx.simulate_keystrokes("enter");
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({
            "type": "machines", "request": 7, "operation": "mutate", "revision": 12,
            "change": {"operation": "disable", "id": ID}
        })
    );
    view.read_with(cx, |v, _| {
        assert!(v.picker.is_some());
        assert_eq!(v.browser_request, 7);
        assert!(
            v.browser_state.machines.as_ref().unwrap().machines[0].enabled,
            "no optimistic registry mutation"
        );
    });
    assert!(receiver.try_recv().is_err());
}
#[test]
fn management_rows_and_stale_pending_unavailable_actions_are_fenced() {
    let mut state = browser::State {
        machines: Some(registry()),
        ..Default::default()
    };
    let rows = super::super::saved_machines::management_rows(&state, "disable build spark");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].target, disable());
    assert!(current(&state, &disable()));
    state.machines.as_mut().unwrap().pending = true;
    assert!(!current(&state, &disable()));
    state.machines.as_mut().unwrap().pending = false;
    state.machines.as_mut().unwrap().available = false;
    assert!(!current(&state, &disable()));
    state.machines.as_mut().unwrap().available = true;
    state.machines.as_mut().unwrap().revision += 1;
    assert!(!current(&state, &disable()));
    state.machines.as_mut().unwrap().machines[0].enabled = false;
    let enabled = super::super::saved_machines::management_rows(&state, "enable");
    assert_eq!(enabled.len(), 1);
    assert!(current(&state, &enabled[0].target));
    assert_eq!(
        serde_json::to_value(browser::machines::Operation::Mutate {
            revision: 13,
            change: browser::machines::Change::Enable { id: ID.into() }
        })
        .unwrap(),
        serde_json::json!({"operation":"mutate","revision":13,"change":{"operation":"enable","id":ID}})
    );
}
