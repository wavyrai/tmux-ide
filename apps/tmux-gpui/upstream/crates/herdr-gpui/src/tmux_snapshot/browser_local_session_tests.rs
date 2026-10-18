use super::super::*;
#[test]
fn capability_requires_empty_live_home() -> anyhow::Result<()> {
    let mut wire: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))?;
    wire["home"] = serde_json::json!({"phase":"live"});
    wire["surface"] = "home".into();
    wire["sessions"] = serde_json::json!([]);
    wire["panes"] = serde_json::json!([]);
    wire["selectedServer"] = serde_json::Value::Null;
    wire["localSessionCreate"] =
        serde_json::json!({"action":"11111111-1111-4111-8111-111111111111"});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&wire)?)?
            .local_session_create
            .is_some()
    );
    for (key, value) in [
        ("surface", serde_json::json!("workspace")),
        ("home", serde_json::json!({"phase":"loading"})),
        ("inputReady", serde_json::json!(true)),
        ("selectedPane", serde_json::json!("%0")),
        ("resizeGestureSupported", serde_json::json!(true)),
        ("localSetup", serde_json::json!({"phase":"available"})),
        (
            "localSessionCreate",
            serde_json::json!({"action":"invalid"}),
        ),
        (
            "localSessionCreate",
            serde_json::json!({"action":"11111111-1111-4111-8111-111111111111", "path":"private"}),
        ),
    ] {
        let mut invalid = wire.clone();
        invalid[key] = value;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&invalid)?)
                .is_err(),
            "{key}"
        );
    }
    wire["localSessionCreate"] = serde_json::Value::Null;
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&wire)?)?
            .local_session_create
            .is_none()
    );
    Ok(())
}
