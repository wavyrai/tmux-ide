#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
fn pending() -> Pending {
    Pending {
        action: Action::NewWindow,
        operation: "operation".into(),
        sequence: 1,
        source: "source".into(),
    }
}
fn response() -> serde_json::Value {
    json!({"type":"native-owner-action-result","version":1,"id":"id","request":1,"sequence":1,"operationId":"operation","status":"created","receipt":{"operationId":"operation","daemonInstanceId":"generation","outcome":"created","resource":{"resourceVersion":1,"workspaceName":"workspace","semanticPaneId":"created","displayTitle":"Terminal","kind":"terminal","harnessProfileId":null,"role":null,"missionId":null}}})
}
#[test]
fn receipt_fences_generation_workspace_operation_and_resource() {
    let base = response();
    let parsed: Response = serde_json::from_value(base.clone()).unwrap();
    assert_eq!(
        validate_result(&parsed, &pending(), "generation", "workspace").unwrap(),
        Some("created".into())
    );
    for path in [
        "/receipt/operationId",
        "/receipt/daemonInstanceId",
        "/receipt/resource/workspaceName",
        "/receipt/outcome",
    ] {
        let mut changed = base.clone();
        *changed.pointer_mut(path).unwrap() = json!("wrong");
        assert!(
            validate_result(
                &serde_json::from_value(changed).unwrap(),
                &pending(),
                "generation",
                "workspace"
            )
            .is_err()
        );
    }
    for pane in ["source", "%12", "../path", " x", "a\0b"] {
        let mut changed = base.clone();
        changed["receipt"]["resource"]["semanticPaneId"] = json!(pane);
        assert!(
            validate_result(
                &serde_json::from_value(changed).unwrap(),
                &pending(),
                "generation",
                "workspace"
            )
            .is_err()
        );
    }
}
#[test]
fn strict_receipt_fields_and_failed_null_are_rejected() {
    let mut changed = response();
    changed["receipt"]["resource"]["extra"] = json!(true);
    assert!(serde_json::from_value::<Response>(changed).is_err());
    let mut changed = response();
    changed["status"] = json!("failed");
    changed["receipt"] = json!(null);
    assert!(serde_json::from_value::<Response>(changed).is_err());
    let mut changed = response();
    changed["status"] = json!("failed");
    changed.as_object_mut().unwrap().remove("receipt");
    assert!(
        validate_result(
            &serde_json::from_value(changed).unwrap(),
            &pending(),
            "generation",
            "workspace"
        )
        .unwrap()
        .is_none()
    );
}
#[test]
fn agent_name_harness_and_role_must_match_requested_action() {
    let mut p = pending();
    p.action = Action::NewAgent {
        name: "Agent".into(),
        harness: Harness::Codex,
    };
    let mut raw = response();
    let r = &mut raw["receipt"]["resource"];
    r["kind"] = json!("agent");
    r["displayTitle"] = json!("Agent");
    r["harnessProfileId"] = json!("codex");
    r["role"] = json!("implementer");
    assert!(
        validate_result(
            &serde_json::from_value(raw.clone()).unwrap(),
            &p,
            "generation",
            "workspace"
        )
        .is_ok()
    );
    raw["receipt"]["resource"]["harnessProfileId"] = json!("claude");
    assert!(
        validate_result(
            &serde_json::from_value(raw).unwrap(),
            &p,
            "generation",
            "workspace"
        )
        .is_err()
    );
}
#[test]
fn request_flattens_action_without_duplicate_type_and_request_scope_advances() {
    let request = Request {
        version: 1,
        id: "id".into(),
        request: 2,
        sequence: 3,
        operation_id: "operation".into(),
        live_session_id: "session".into(),
        generation: "generation".into(),
        pane: "source".into(),
        action: Action::NewAgent {
            name: "Agent".into(),
            harness: Harness::Claude,
        },
    };
    let value = serde_json::to_value(request).unwrap();
    assert!(value.get("type").is_none());
    assert_eq!(value["action"], "new-agent");
    assert_eq!(value["harness"], "claude");
    assert_eq!(value["liveSessionId"], "session");
    let mut owner = Owner::new(
        uuid::Uuid::new_v4().to_string(),
        1,
        "workspace".into(),
        "session".into(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    owner.highest = 8;
    owner.update_request(2).unwrap();
    assert_eq!(owner.highest, 8);
    assert!(owner.update_request(2).is_err());
}
