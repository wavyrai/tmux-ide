use super::*;

#[test]
fn fleet_wire_rejects_private_fields_invalid_tokens_and_selectable_failed_hosts()
-> anyhow::Result<()> {
    let original: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))?;
    let state = Reader::default().accept(&serde_json::to_vec(&original)?)?;
    assert!(state.fleet.as_ref().is_some_and(|f| f.groups.len() == 1));
    for (field, value) in [
        ("state", serde_json::json!("disconnected")),
        ("conflict", serde_json::json!(true)),
        ("ownerToken", serde_json::json!("secret")),
    ] {
        let mut bad = original.clone();
        bad["fleet"]["groups"][0][field] = value;
        let mut reader = Reader::default();
        assert!(reader.accept(&serde_json::to_vec(&bad)?).is_err());
        reader.accept(&serde_json::to_vec(&original)?)?;
    }
    let mut bad = original.clone();
    bad["fleet"]["groups"][0]["sessions"][0]["selection"] = serde_json::json!("not-a-token");
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&bad)?)
            .is_err()
    );
    bad["fleet"]["groups"][0]["sessions"][0]["selection"] = serde_json::Value::Null;
    bad["fleet"]["groups"][0]["state"] = serde_json::json!("disconnected");
    Reader::default().accept(&serde_json::to_vec(&bad)?)?;
    Ok(())
}

#[test]
fn captured_fleet_startup_reaches_two_selectable_sessions() -> anyhow::Result<()> {
    // Captured from the real --local bridge against an isolated daemon. Session
    // display names are anonymized; protocol structure and ordering are retained.
    let wire = include_str!("../../../../../fixtures/browser-fleet-startup.jsonl");
    let mut reader = Reader::default();
    let mut last = None;
    for line in wire.lines() {
        last = Some(reader.accept(line.as_bytes())?);
    }
    let state = last.ok_or_else(|| anyhow::anyhow!("missing captured startup publications"))?;
    let fleet = state
        .fleet
        .ok_or_else(|| anyhow::anyhow!("missing fleet metadata"))?;
    assert_eq!(fleet.groups.len(), 1);
    assert_eq!(fleet.groups[0].sessions.len(), 2);
    assert!(
        fleet.groups[0]
            .sessions
            .iter()
            .all(|session| session.selection.is_some())
    );
    assert_eq!(state.home_phase, HomePhase::Live);
    Ok(())
}
