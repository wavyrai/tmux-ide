use super::*;
use serde_json::json;
#[test]
fn workspace_fleet_agents_are_optional_scoped_bounded_and_selected_exactly() -> anyhow::Result<()> {
    let mut value: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../fixtures/browser-initial.json"
    ))?;
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)?
            .workspace_fleet_agents
            .is_none()
    );
    value["surface"] = json!("workspace");
    value["request"] = json!(7);
    let roster = json!({"request":7,"scope":1,"revision":1,"phase":"partial","selectedKey":null,"rows":[],"observedSessions":1,"totalSessions":2,"truncatedSessions":1,"truncatedRows":0,"note":null});
    value["workspaceFleetAgents"] = roster.clone();
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_ok()
    );
    for (field, invalid) in [
        ("request", json!(8)),
        ("scope", json!(0)),
        ("revision", json!(9_007_199_254_740_992u64)),
        ("selectedKey", json!("not-present")),
        ("unknown", json!(true)),
    ] {
        value["workspaceFleetAgents"] = roster.clone();
        value["workspaceFleetAgents"][field] = invalid;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&value)?)
                .is_err()
        );
    }
    value["workspaceFleetAgents"] = roster;
    value["surface"] = json!("home");
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    value["workspaceFleetAgents"] = json!(null);
    value["workspaceFleetAgentRejected"] =
        json!({"request":8,"fromRequest":7,"scope":1,"rosterRevision":1,"key":"opaque"});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_ok()
    );
    value["workspaceFleetAgentRejected"]["fromRequest"] = json!(6);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(Command::OpenWorkspaceFleetAgent {
            request: 8,
            from_request: 7,
            scope: 1,
            roster_revision: 1,
            key: "opaque".into()
        })?,
        json!({"type":"open-workspace-fleet-agent","request":8,"fromRequest":7,"scope":1,"rosterRevision":1,"key":"opaque"})
    );
    Ok(())
}
