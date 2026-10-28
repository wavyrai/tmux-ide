use super::*;
#[test]
fn machine_filter_decode_fences_scope_revision_and_exact_membership() -> anyhow::Result<()> {
    let mut value = home();
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)?
            .home_agent_filter
            .is_none()
    );
    value["fleet"] = json!({"groups":[],"omittedGroups":0});
    value["homeAgents"] = json!({"revision":9,"phase":"live","rows":[],"observedSessions":0,"totalSessions":0,"truncatedSessions":0,"truncatedRows":0,"note":null});
    value["homeAgentFilter"] = json!({"revision":9,"machineId":null});
    Reader::default().accept(&serde_json::to_vec(&value)?)?;
    for (field, bad_value) in [
        ("revision", json!(0)),
        ("revision", json!(8)),
        ("revision", json!(9007199254740992u64)),
        ("machineId", json!("removed")),
        ("unexpected", json!(true)),
    ] {
        let mut bad = value.clone();
        bad["homeAgentFilter"][field] = bad_value;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&bad)?)
                .is_err()
        );
    }
    value["surface"] = json!("workspace");
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    Ok(())
}
