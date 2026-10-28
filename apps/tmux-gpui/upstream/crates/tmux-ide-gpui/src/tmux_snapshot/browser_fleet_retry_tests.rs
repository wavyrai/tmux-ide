use super::*;

#[test]
fn fleet_retry_wire_rejects_ready_conflicted_and_malformed_capabilities() -> anyhow::Result<()> {
    let mut message: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))?;
    message["fleet"]["groups"][0]["sessions"] = serde_json::json!([]);
    message["fleet"]["groups"][0]["state"] = serde_json::json!("disconnected");
    message["fleet"]["groups"][0]["retry"] =
        serde_json::json!("fe470cdc-82bb-48d5-8fc4-1fa68025c8e4");
    Reader::default().accept(&serde_json::to_vec(&message)?)?;
    for (field, value) in [
        ("state", serde_json::json!("ready")),
        ("conflict", serde_json::json!(true)),
        ("retry", serde_json::json!("invalid")),
    ] {
        let mut bad = message.clone();
        bad["fleet"]["groups"][0][field] = value;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&bad)?)
                .is_err()
        );
    }
    Ok(())
}
