use super::*;

#[test]
fn worktree_failure_stays_in_dialog_after_snapshots_and_successful_retry() {
    let mut state = LiveState {
        status: ConnectionStatus::Connected,
        dialog_response: Some(("create".into(), None)),
        ..LiveState::default()
    };
    let response = serde_json::json!({"error": {
        "code": "worktree_create_failed",
        "message": "fatal: 'config reload' is not a valid branch name"
    }});
    state.apply(ClientEvent::Response {
        request_id: "create".into(),
        response: response.clone(),
    });
    state.apply(ClientEvent::Snapshot(snapshot()));
    assert_eq!(state.status_text(None), "Connected");
    assert!(matches!(&state.dialog_response,
        Some((id, Some(Ok(value)))) if id == "create" && value == &response));

    state.dialog_response = Some(("retry".into(), None));
    state.apply(ClientEvent::Response {
        request_id: "retry".into(),
        response: serde_json::json!({"result": {}}),
    });
    state.dialog_response = None;
    assert_eq!(state.status_text(None), "Connected");
}

#[test]
fn drag_request_clears_only_on_its_own_answer() {
    let mut state = LiveState {
        drag_request: Some("scroll".into()),
        ..LiveState::default()
    };
    state.apply(ClientEvent::Response {
        request_id: "other".into(),
        response: serde_json::json!({"result": {}}),
    });
    state.apply(ClientEvent::CommandRejected {
        request_id: None,
        reason: herdr_client::Error::Disconnected,
    });
    assert_eq!(state.drag_request.as_deref(), Some("scroll"));
    state.apply(ClientEvent::Response {
        request_id: "scroll".into(),
        response: serde_json::json!({"result": {}}),
    });
    assert_eq!(state.drag_request, None);

    state.drag_request = Some("scroll".into());
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("scroll".into()),
        reason: herdr_client::Error::CommandBoot,
    });
    assert_eq!(state.drag_request, None);
}

#[test]
fn dialog_response_is_correlated_and_survives_coalescing() {
    let mut state = LiveState {
        dialog_response: Some(("remove".into(), None)),
        ..LiveState::default()
    };
    let response =
        serde_json::json!({"error":{"code":"dirty_worktree_requires_force", "message":"dirty"}});
    state.apply(ClientEvent::Response {
        request_id: "remove".into(),
        response: response.clone(),
    });
    state.apply(ClientEvent::Response {
        request_id: "other".into(),
        response: serde_json::json!({"result":{}}),
    });
    state.apply(ClientEvent::Snapshot(snapshot()));
    assert!(
        matches!(&state.dialog_response, Some((id, Some(Ok(value)))) if id == "remove" && value == &response)
    );
    state.dialog_response = Some(("next".into(), None));
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("other".into()),
        reason: herdr_client::Error::Disconnected,
    });
    assert!(matches!(&state.dialog_response, Some((id, None)) if id == "next"));
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("next".into()),
        reason: herdr_client::Error::CommandBoot,
    });
    assert!(
        matches!(&state.dialog_response, Some((id, Some(Err(error)))) if id == "next" && matches!(error.as_ref(), crate::Error::Client(herdr_client::Error::CommandBoot)))
    );
}

#[test]
fn rename_failures_stay_typed_and_shared_across_mailbox_clones() {
    let mut state = LiveState {
        tab_rename: Some(RenameResult {
            request: "rename".into(),
            result: None,
        }),
        ..LiveState::default()
    };
    let payload = serde_json::json!({"code": "invalid_label", "message": "Invalid label"});
    state.apply(ClientEvent::Response {
        request_id: "other".into(),
        response: serde_json::json!({"error": payload}),
    });
    assert!(state.tab_rename.as_ref().unwrap().result.is_none());
    assert_eq!(state.error.take().as_deref(), Some("Invalid label"));
    state.apply(ClientEvent::Response {
        request_id: "rename".into(),
        response: serde_json::json!({"error": payload}),
    });
    let cloned = state.clone();
    let error = state
        .tab_rename
        .as_ref()
        .unwrap()
        .result
        .as_ref()
        .unwrap()
        .as_ref()
        .unwrap_err();
    let shared = cloned
        .tab_rename
        .as_ref()
        .unwrap()
        .result
        .as_ref()
        .unwrap()
        .as_ref()
        .unwrap_err();
    assert!(Arc::ptr_eq(error, shared));
    assert!(matches!(error.as_ref(), crate::Error::DaemonResponse(value) if value == &payload));
    assert_eq!(error.to_string(), "Invalid label");
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("rename".into()),
        reason: herdr_client::Error::CommandBoot,
    });
    assert!(matches!(
        state
            .tab_rename
            .as_ref()
            .unwrap()
            .result
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap_err()
            .as_ref(),
        crate::Error::Client(herdr_client::Error::CommandBoot)
    ));
    assert!(state.error.is_none());
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("rename".into()),
        reason: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied").into(),
    });
    let cloned = state.clone();
    let error = state
        .tab_rename
        .as_ref()
        .unwrap()
        .result
        .as_ref()
        .unwrap()
        .as_ref()
        .unwrap_err();
    let shared = cloned
        .tab_rename
        .as_ref()
        .unwrap()
        .result
        .as_ref()
        .unwrap()
        .as_ref()
        .unwrap_err();
    assert!(Arc::ptr_eq(error, shared));
    use std::error::Error as _;
    assert!(
        error
            .source()
            .and_then(|source| source.source())
            .and_then(|source| source.downcast_ref::<std::io::Error>())
            .is_some_and(|source| source.kind() == std::io::ErrorKind::PermissionDenied)
    );
}
