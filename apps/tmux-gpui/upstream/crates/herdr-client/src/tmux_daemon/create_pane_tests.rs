#![allow(clippy::unwrap_used)]
use super::*;
fn fixture() -> (Uuid, String, PaneCreation, serde_json::Value) {
    let op = Uuid::new_v4();
    let generation = Uuid::new_v4().to_string();
    let c = PaneCreation {
        workspace_name: "fixture".into(),
        live_session_id: format!("live-session.{}", "a".repeat(20)),
        source_pane: "pane.source".into(),
        kind: NewPane::Terminal,
    };
    let value = serde_json::json!({"operationId":op.to_string(),"daemonInstanceId":generation,"outcome":"created","resource":{
        "resourceVersion":1,"workspaceName":"fixture","semanticPaneId":"pane.created","displayTitle":"Shell","kind":"terminal","harnessProfileId":null,"role":null,"missionId":null }});
    (op, generation, c, value)
}
#[test]
fn creation_body_is_semantic_and_rejects_query_injection() {
    let (op, generation, mut c, _) = fixture();
    let value: serde_json::Value =
        serde_json::from_slice(&body(op, &generation, &c).unwrap()).unwrap();
    assert_eq!(
        value["intent"],
        serde_json::json!({"workspaceName":"fixture","kind":"terminal","placement":{"kind":"window"}})
    );
    c.live_session_id.push_str("&other=server");
    assert!(matches!(body(op, &generation, &c), Err(Error::ActionInput)));
    c.live_session_id = format!("live-session.{}", "a".repeat(20));
    for name in [" name", "name\n", "\u{feff}name", "", "a\u{85}"] {
        c.kind = NewPane::Agent {
            name: name.into(),
            harness: AgentHarness::Codex,
        };
        assert!(body(op, &generation, &c).is_err());
    }
    c.kind = NewPane::Agent {
        name: "Agent 1".into(),
        harness: AgentHarness::Claude,
    };
    let value: serde_json::Value =
        serde_json::from_slice(&body(op, &generation, &c).unwrap()).unwrap();
    assert_eq!(value["intent"]["harnessProfileId"], "claude");
    assert_eq!(value["intent"]["role"], "implementer");
}
#[test]
fn receipts_match_operation_generation_workspace_and_new_pane() {
    let (op, generation, c, value) = fixture();
    assert!(parse(&serde_json::to_vec(&value).unwrap(), op, &generation, &c).is_ok());
    for field in ["operationId", "daemonInstanceId"] {
        let mut bad = value.clone();
        bad[field] = Uuid::new_v4().to_string().into();
        assert!(matches!(
            parse(&serde_json::to_vec(&bad).unwrap(), op, &generation, &c),
            Err(Error::ServerChanged)
        ));
    }
    let mut bad = value.clone();
    bad["resource"]["workspaceName"] = "other".into();
    assert!(matches!(
        parse(&serde_json::to_vec(&bad).unwrap(), op, &generation, &c),
        Err(Error::ServerChanged)
    ));
    let mut bad = value;
    bad["resource"]["semanticPaneId"] = c.source_pane.clone().into();
    assert!(matches!(
        parse(&serde_json::to_vec(&bad).unwrap(), op, &generation, &c),
        Err(Error::ResourceFormat)
    ));
}
#[test]
fn receipt_nullable_fields_are_required_and_agent_details_are_exact() {
    let (op, generation, mut c, mut value) = fixture();
    for field in ["harnessProfileId", "role", "missionId"] {
        let mut bad = value.clone();
        bad["resource"].as_object_mut().unwrap().remove(field);
        assert!(parse(&serde_json::to_vec(&bad).unwrap(), op, &generation, &c).is_err());
    }
    c.kind = NewPane::Agent {
        name: "Agent".into(),
        harness: AgentHarness::Codex,
    };
    value["resource"]["kind"] = "agent".into();
    value["resource"]["displayTitle"] = "Agent".into();
    value["resource"]["harnessProfileId"] = "codex".into();
    value["resource"]["role"] = "implementer".into();
    assert!(parse(&serde_json::to_vec(&value).unwrap(), op, &generation, &c).is_ok());
    for field in ["displayTitle", "harnessProfileId", "role", "missionId"] {
        let mut bad = value.clone();
        bad["resource"][field] = "unexpected".into();
        assert!(parse(&serde_json::to_vec(&bad).unwrap(), op, &generation, &c).is_err());
    }
    let mut bad = value;
    bad["resource"]["directory"] = "/private/never-exposed".into();
    assert!(parse(&serde_json::to_vec(&bad).unwrap(), op, &generation, &c).is_err());
}
