use super::*;

#[test]
fn fleet_disconnect_wire_rejects_malformed_and_reused_capabilities() -> anyhow::Result<()> {
    let mut message: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))?;
    let token = "fe470cdc-82bb-48d5-8fc4-1fa68025c8e4";
    message["fleet"]["groups"][0]["disconnect"] = serde_json::json!(token);
    Reader::default().accept(&serde_json::to_vec(&message)?)?;
    let mut bad = message.clone();
    bad["fleet"]["groups"][0]["disconnect"] = serde_json::json!("invalid");
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&bad)?)
            .is_err()
    );
    bad = message.clone();
    bad["fleet"]["groups"][0]["sessions"][0]["selection"] = serde_json::json!(token);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&bad)?)
            .is_err()
    );
    // Catalog failure/conflict does not mean the underlying SSH transport stopped.
    message["fleet"]["groups"][0]["sessions"] = serde_json::json!([]);
    message["fleet"]["groups"][0]["state"] = serde_json::json!("disconnected");
    message["fleet"]["groups"][0]["conflict"] = serde_json::json!(true);
    Reader::default().accept(&serde_json::to_vec(&message)?)?;
    Ok(())
}
