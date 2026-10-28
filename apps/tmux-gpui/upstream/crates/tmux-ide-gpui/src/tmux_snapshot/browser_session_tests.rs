use super::*;
use serde_json::json;
#[test]
fn preferred_pane_requires_completed_read_only_catalog_membership() -> anyhow::Result<()> {
    let value = json!({"version":1,"connection":"helper","sequence":1,"request":1,
        "surface":"workspace","sessions":[{"id":"s","label":"Session"}],
        "panes":[{"id":"p","label":"Pane","windowId":"w"}],"selectedSession":"s",
        "selectedPane":null,"snapshot":null,"inputReady":false,"status":"Choose a pane",
        "sessionCatalogComplete":true,"preferredPane":"p"});
    let state = Reader::default().accept(&serde_json::to_vec(&value)?)?;
    assert_eq!(state.preferred_pane.as_deref(), Some("p"));
    for (field, invalid) in [
        ("preferredPane", json!("removed")),
        ("sessionCatalogComplete", json!(false)),
        ("inputReady", json!(true)),
        ("selectedPane", json!("p")),
        ("selectedSession", serde_json::Value::Null),
        ("panes", json!([{"id":"p","label":"Pane"}])),
    ] {
        let mut bad = value.clone();
        bad[field] = invalid;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&bad)?)
                .is_err(),
            "{field}"
        );
    }
    let mut legacy = value;
    legacy
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("object"))?
        .remove("preferredPane");
    legacy
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("object"))?
        .remove("sessionCatalogComplete");
    let legacy = Reader::default().accept(&serde_json::to_vec(&legacy)?)?;
    assert!(!legacy.session_catalog_complete);
    assert!(legacy.preferred_pane.is_none());
    Ok(())
}
