use super::*;

#[test]
fn recovery_capability_requires_exact_home_roster_and_is_optional() -> anyhow::Result<()> {
    let mut value = home();
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)?
            .home_agent_recovery
            .is_none()
    );
    value["fleet"] = json!({"groups":[],"omittedGroups":0});
    value["homeAgents"] = json!({"revision":9,"phase":"partial","rows":[],"observedSessions":1,"totalSessions":2,"truncatedSessions":1,"truncatedRows":0,"note":null});
    value["homeAgentRecovery"] = json!({"revision":9,"canRetry":true,"canLoadMore":true});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)?
            .home_agent_recovery
            .is_some()
    );
    for (field, invalid) in [
        ("revision", json!(8)),
        ("revision", json!(0)),
        ("canRetry", json!("yes")),
        ("unknown", json!(true)),
    ] {
        let mut bad = value.clone();
        bad["homeAgentRecovery"][field] = invalid;
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
