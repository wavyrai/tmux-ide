use super::*;
#[test]
fn local_setup_is_optional_strict_and_serializes_non_navigation_request() -> anyhow::Result<()> {
    let original: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))?;
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&original)?)?
            .local_setup
            .is_none()
    );
    for phase in [
        "available",
        "running",
        "missing",
        "unsupported",
        "failed",
        "stopped-waiting",
    ] {
        let mut wire = original.clone();
        wire["localSetup"] = serde_json::json!({"phase": phase});
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&wire)?)?
                .local_setup
                .is_some()
        );
    }
    for value in [
        serde_json::json!({"phase":"unknown"}),
        serde_json::json!({"phase":"available","path":"private"}),
    ] {
        let mut wire = original.clone();
        wire["localSetup"] = value;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&wire)?)
                .is_err()
        );
    }
    let mut workspace = original.clone();
    workspace["surface"] = serde_json::json!("workspace");
    workspace["localSetup"] = serde_json::json!({"phase":"available"});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&workspace)?)
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(Command::LocalSetup { request: 0 })?,
        serde_json::json!({"type":"local-setup","request":0})
    );
    Ok(())
}
