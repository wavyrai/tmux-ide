#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
fn scope() -> ServerScope {
    ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
    }
}
fn fixture() -> Value {
    json!({"version":1,"server":scope(),"resource":{
    "project":{"name":"Fixture"},"workspace":{"sidebar":{"agents":[{
        "id":"agent.one","name":"Build","harness":"codex","activity":"running","paneId":"pane.one","attention":true,
        "team":{"id":"team.abcdefghijklmnop","name":"Builders","source":"manual"}
    }]}},"terminalInventory":{"activeResourceId":"pane.one","resources":[{
        "id":"pane.one","title":"Build","kind":"agent","active":true,
        "attachability":{"status":"available","semanticPaneId":"pane.one"},
        "nativeIdentity":{"serverEpoch":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","paneBirthId":"18446744073709551615"},
        "interactionEndpoint":{"kind":"pane","environmentId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","serverScope":scope(),
            "paneLifetimeId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","workspaceName":"docs/site","semanticPaneId":"pane.one"},
        "windowResourceId":format!("terminal-window.{}","b".repeat(20))
    }]}}})
}
fn decode(value: Value) -> Result<AgentObservation, Error> {
    parse(
        value.to_string().as_bytes(),
        &scope(),
        &format!("live-session.{}", "a".repeat(20)),
        "docs/site",
    )
}
#[test]
fn scoped_observation_preserves_activity_and_current_identity() {
    let result = decode(fixture()).unwrap();
    assert_eq!(result.project_name, "Fixture");
    assert_eq!(result.agents.len(), 1);
    let row = &result.agents[0];
    assert_eq!(row.activity, AgentActivity::Running);
    assert!(row.attention);
    assert_eq!(row.pane_id.as_deref(), Some("pane.one"));
    assert_eq!(
        row.native_identity.as_ref().unwrap().pane_birth_id,
        "18446744073709551615"
    );
    assert_eq!(
        row.interaction_endpoint.as_ref().unwrap().server_scope,
        scope()
    );
    assert_eq!(row.team.as_ref().unwrap().name, "Builders");
}
#[test]
fn unavailable_and_unattached_agents_do_not_gain_identity() {
    let mut value = fixture();
    let resource = &mut value["resource"]["terminalInventory"]["resources"][0];
    resource["attachability"] = json!({"status":"unavailable","reason":"missing-semantic-stamp"});
    resource.as_object_mut().unwrap().remove("windowResourceId");
    let row = decode(value).unwrap().agents.remove(0);
    assert!(row.native_identity.is_none());
    assert!(row.interaction_endpoint.is_none());
    let mut value = fixture();
    value["resource"]["workspace"]["sidebar"]["agents"][0]["paneId"] = Value::Null;
    let row = decode(value).unwrap().agents.remove(0);
    assert!(row.pane_id.is_none());
    assert!(row.native_identity.is_none());
}
#[test]
fn rejects_cross_scope_duplicate_and_inconsistent_bindings() {
    for case in 0..14 {
        let mut value = fixture();
        match case {
            0 => value["server"]["generation"] = json!(uuid::Uuid::new_v4().to_string()),
            1 => value["resource"]["terminalInventory"]["resources"][0]["kind"] = json!("terminal"),
            2 => {
                value["resource"]["terminalInventory"]["resources"][0]["attachability"]["semanticPaneId"] =
                    json!("pane.other")
            }
            3 => {
                value["resource"]["terminalInventory"]["resources"][0]["interactionEndpoint"]["serverScope"]
                    ["generation"] = json!(uuid::Uuid::new_v4().to_string())
            }
            4 => {
                value["resource"]["terminalInventory"]["resources"][0]["interactionEndpoint"]["semanticPaneId"] =
                    json!("pane.other")
            }
            5 => {
                value["resource"]["terminalInventory"]["resources"][0]["interactionEndpoint"]["workspaceName"] =
                    json!("different")
            }
            6 => value["resource"]["terminalInventory"]["activeResourceId"] = Value::Null,
            7 => {
                let row = value["resource"]["terminalInventory"]["resources"][0].clone();
                value["resource"]["terminalInventory"]["resources"]
                    .as_array_mut()
                    .unwrap()
                    .push(row);
            }
            8 => {
                let mut row = value["resource"]["workspace"]["sidebar"]["agents"][0].clone();
                row["id"] = json!("agent.two");
                value["resource"]["workspace"]["sidebar"]["agents"]
                    .as_array_mut()
                    .unwrap()
                    .push(row);
            }
            9 => {
                value["resource"]["workspace"]["sidebar"]["agents"][0]["activity"] =
                    json!("guessed")
            }
            10 => {
                value["resource"]["workspace"]["sidebar"]["agents"][0]["paneId"] = json!("missing")
            }
            11 => {
                value["resource"]["terminalInventory"]["resources"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("nativeIdentity");
            }
            12 => {
                value["resource"]["workspace"]["sidebar"]["agents"][0]["team"]["name"] =
                    json!(" bad\nteam")
            }
            _ => value["unexpected"] = json!(true),
        }
        assert!(decode(value).is_err(), "case {case}");
    }
}
#[test]
fn rejects_unbounded_or_noncanonical_observations() {
    for birth in ["0", "01", "-1", "18446744073709551616", "1.0"] {
        let mut value = fixture();
        value["resource"]["terminalInventory"]["resources"][0]["nativeIdentity"]["paneBirthId"] =
            json!(birth);
        assert!(decode(value).is_err());
    }
    let mut value = fixture();
    value["resource"]["project"]["name"] = json!("x".repeat(161));
    assert!(decode(value).is_err());
    let mut value = fixture();
    let row = value["resource"]["workspace"]["sidebar"]["agents"][0].clone();
    value["resource"]["workspace"]["sidebar"]["agents"] = json!(vec![row; 65]);
    assert!(decode(value).is_err());
    assert!(parse(&vec![b' '; 1024 * 1024 + 1], &scope(), "live", "workspace").is_err());
}

#[test]
fn agent_target_requires_exact_observed_lifetime_but_not_display_labels() {
    let expected = decode(fixture()).unwrap().agents.remove(0);
    let mut renamed = expected.clone();
    renamed.name = "Renamed".into();
    renamed.activity = AgentActivity::Idle;
    assert!(same_agent_target(&expected, &renamed));
    for case in 0..5 {
        let mut changed = expected.clone();
        match case {
            0 => changed.id = "other".into(),
            1 => changed.pane_id = Some("pane.other".into()),
            2 => changed.native_identity.as_mut().unwrap().pane_birth_id = "2".into(),
            3 => {
                changed
                    .interaction_endpoint
                    .as_mut()
                    .unwrap()
                    .pane_lifetime_id = uuid::Uuid::new_v4().to_string()
            }
            _ => changed.native_identity = None,
        }
        assert!(!same_agent_target(&expected, &changed));
    }
}
