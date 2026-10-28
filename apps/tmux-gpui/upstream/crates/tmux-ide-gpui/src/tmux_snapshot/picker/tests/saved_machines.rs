use super::*;

const MACHINE: &str = "00000000-0000-4000-8000-000000000001";
fn registry() -> browser::machines::Registry {
    serde_json::from_value(serde_json::json!({
        "revision": 12, "available": true, "pending": false,
        "error": null, "message": null,
        "machines": [{"id": MACHINE, "label": "Build host", "sshTarget": "demo@spark",
            "expectedEnvironmentId": null, "enabled": true}]
    }))
    .unwrap()
}
fn target() -> Target {
    Target::Machine {
        id: MACHINE.into(),
        revision: 12,
    }
}

#[test]
fn saved_rows_search_labels_and_routes_but_select_only_current_enabled_identity() {
    let mut state = browser::State {
        machines: Some(registry()),
        ..Default::default()
    };
    let rows = super::super::saved_machines::rows(&state, "BUILD spark");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].target, target());
    assert!(current(&state, &target()));
    state.machines.as_mut().unwrap().revision += 1;
    assert!(!current(&state, &target()));
    state.machines.as_mut().unwrap().revision = 12;
    state.machines.as_mut().unwrap().machines[0].enabled = false;
    assert!(!current(&state, &target()));
    state.machines.as_mut().unwrap().machines[0].enabled = true;
    state.machines.as_mut().unwrap().available = false;
    assert!(!current(&state, &target()));
    state.machines.as_mut().unwrap().available = true;
    state.machines.as_mut().unwrap().machines.clear();
    assert!(!current(&state, &target()));
}

#[gpui::test]
fn saved_picker_reads_current_request_and_escape_preserves_terminal_input_latch(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("switch saved machine");
    cx.simulate_keystrokes("enter");
    let command = receiver.try_recv().unwrap();
    assert_eq!(
        serde_json::to_value(command).unwrap(),
        serde_json::json!({
            "type": "machines", "request": 7, "operation": "read"
        })
    );
    cx.simulate_input("spark");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.input_interrupted = true;
            view.queue_input(
                crate::tmux_snapshot::keys::Input::Paste("blocked".into()),
                cx,
            );
            view.replace_text_in_range(None, "blocked", window, cx);
        })
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert!(view.input_interrupted);
        assert_eq!(view.browser_request, 7);
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn saved_picker_rejects_stale_click_then_selects_current_profile_and_retires_terminal(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.machines = Some(registry());
            view.open_saved_machines(window, cx);
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Machines { request: 7, .. }
    ));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.machines.as_mut().unwrap().revision = 13;
            view.choose_picker(target(), window, cx);
            assert!(view.picker.is_some());
            assert_eq!(view.browser_request, 7);
            view.refresh_picker(cx);
            view.choose_picker(
                Target::Machine {
                    id: MACHINE.into(),
                    revision: 13,
                },
                window,
                cx,
            );
            assert!(view.picker.is_none());
            assert!(!view.browser_state.input_ready);
            assert!(view.browser_state.selected_pane.is_none());
            assert_eq!(view.browser_state.surface, browser::Surface::Home);
        })
    });
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({
            "type": "machine-profile", "request": 8, "id": MACHINE, "revision": 13
        })
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn saved_picker_reports_read_queue_failure_without_retiring_current_terminal(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    drop(receiver);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_saved_machines(window, cx);
            assert_eq!(
                view.picker.as_ref().unwrap().error,
                Some("Machine list unavailable — close and try again")
            );
            assert_eq!(view.browser_request, 7);
            assert!(view.browser_state.input_ready);
            view.close_picker(window, cx);
            assert!(view.terminal_focus.is_focused(window));
        })
    });
}
