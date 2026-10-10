use super::*;

#[test]
fn rejected_dialog_command_preserves_connection_diagnostic() {
    let mut state = LiveState {
        status: ConnectionStatus::Disconnected,
        error: Some("socket closed".into()),
        dialog_response: Some(("create".into(), None)),
        ..LiveState::default()
    };
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("create".into()),
        reason: herdr_client::Error::Disconnected,
    });
    assert_eq!(state.status_text(None), "Disconnected: socket closed");
    assert!(matches!(&state.dialog_response, Some((_, Some(Err(_))))));
}

#[test]
fn untracked_daemon_errors_remain_visible_as_readable_messages() {
    let mut state = LiveState {
        status: ConnectionStatus::Connected,
        ..LiveState::default()
    };
    for (payload, expected) in [
        (
            serde_json::json!({"code": "failed", "message": "Input failed"}),
            "Input failed",
        ),
        (serde_json::json!("Legacy failure"), "Legacy failure"),
        (serde_json::json!({"code": "unsupported"}), "unsupported"),
        (
            serde_json::json!({"unexpected": true}),
            "Invalid daemon error",
        ),
    ] {
        state.apply(ClientEvent::Response {
            request_id: "input".into(),
            response: serde_json::json!({"error": payload}),
        });
        assert_eq!(state.status_text(None), format!("Connected: {expected}"));
    }
}

#[test]
fn missing_installation_survives_disconnect_but_clears_on_success() {
    let mut state = LiveState::default();
    assert!(!state.missing_installation);
    state.missing_installation = true;
    state.apply(ClientEvent::Disconnected {
        reason: "Herdr not found".into(),
        ssh: None,
    });
    assert!(state.missing_installation);
    state.set_outer_focus(true);
    assert!(state.missing_installation);
    state.apply(ClientEvent::Snapshot(snapshot()));
    assert!(!state.missing_installation);
}

#[test]
fn daemon_loader_stops_on_success_or_failure() {
    let mut state = LiveState::default();
    assert_eq!(state.status, ConnectionStatus::Connecting);
    state.dirty = false;
    state.daemon_starting();
    assert!(state.dirty);
    assert_eq!(state.status, ConnectionStatus::StartingDaemon);
    assert!(!state.status.is_connected());
    assert_eq!(
        state.status_text(Some("old input error")),
        "Starting Herdr server..."
    );
    state.apply(ClientEvent::Snapshot(snapshot()));
    assert_eq!(state.status, ConnectionStatus::Connected);

    state.daemon_starting();
    state.apply(ClientEvent::Disconnected {
        reason: "startup failed".into(),
        ssh: None,
    });
    assert_eq!(state.status, ConnectionStatus::Disconnected);
    assert_eq!(state.error.as_deref(), Some("startup failed"));
}

#[test]
fn connection_status_and_error_priority_follow_lifecycle() {
    let mut state = LiveState::default();
    assert_eq!(state.status, ConnectionStatus::Connecting);
    assert!(!state.status.is_connected());
    assert_eq!(state.status_text(Some("old input error")), "Connecting...");
    state.apply(ClientEvent::Snapshot(snapshot()));
    assert!(state.status.is_connected());
    assert_eq!(
        state.status_text(Some("input error")),
        "Connected: input error"
    );
    state.apply(ClientEvent::Disconnected {
        reason: "socket closed".into(),
        ssh: None,
    });
    assert!(!state.status.is_connected());
    assert_eq!(
        state.status_text(Some("old input error")),
        "Disconnected: socket closed"
    );
    state.status = ConnectionStatus::Detached;
    state.error = None;
    assert!(!state.status.is_connected());
    assert_eq!(
        state.status_text(Some("old input error")),
        "Detached (daemon still running)"
    );
    assert!(ConnectionStatus::AwaitingSnapshot.is_connected());
    assert_eq!(
        ConnectionStatus::AwaitingSnapshot.to_string(),
        "Connected; waiting for snapshot"
    );
}
