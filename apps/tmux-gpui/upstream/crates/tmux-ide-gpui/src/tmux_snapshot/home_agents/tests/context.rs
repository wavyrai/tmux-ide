use super::*;
#[test]
fn optional_context_is_bounded_and_searches_each_field_without_affecting_authority() {
    let mut value = serde_json::json!({"revision":1,"phase":"live","rows":[{"key":"opaque","sessionId":"s","paneId":"p","name":"Same","sessionLabel":"Session","status":"WORKING","attention":true,"available":true}],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null});
    let legacy: Roster = serde_json::from_value(value.clone()).unwrap();
    assert!(legacy.valid());
    assert_eq!(legacy.rows[0].context_label(), "Session");
    for (field, query) in [
        ("machineLabel", "Build host"),
        ("serverLabel", "Server two"),
        ("projectName", "Project alpha"),
        ("harness", "Codex"),
        ("teamName", "Review team"),
    ] {
        value["rows"][0][field] = query.into();
        let roster: Roster = serde_json::from_value(value.clone()).unwrap();
        assert!(roster.valid());
        assert!(roster.rows[0].matches_query(&format!("  {}  ", query.to_uppercase())));
        assert!(roster.available("opaque"));
        for bad in ["x".repeat(161), "control\nvalue".into()] {
            let mut bad_value = value.clone();
            bad_value["rows"][0][field] = bad.into();
            assert!(!serde_json::from_value::<Roster>(bad_value).unwrap().valid());
        }
    }
    let roster: Roster = serde_json::from_value(value).unwrap();
    assert_eq!(
        roster.rows[0].context_label(),
        "Build host · Server two · Session"
    );
    assert!(!roster.rows[0].matches_query("host server"));
    assert!(!roster.rows[0].matches_query("WORKING"));
}
