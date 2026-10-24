use super::*;
use serde_json::json;

fn history() -> anyhow::Result<serde_json::Value> {
    Ok(
        json!({"version":1,"connection":"history","sequence":1,"request":1,
        "surface":"workspace","inputReady":false,"historyOffset":30,
        "sessions":[{"id":"s","label":"Session"}],
        "panes":[{"id":"p","label":"Pane"}],
        "selectedSession":"s","selectedPane":"p","status":"History",
        "snapshot":serde_json::from_str::<serde_json::Value>(include_str!("../../../../../fixtures/snapshot.json"))?}),
    )
}

#[test]
fn history_is_bounded_read_only_and_bound_to_a_selected_frame() -> anyhow::Result<()> {
    let value = history()?;
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    for (field, invalid) in [
        ("historyOffset", json!(-1)),
        ("historyOffset", json!(1001)),
        ("historyOffset", json!(1.5)),
        ("historyOffset", json!("30")),
        ("snapshot", json!(null)),
        ("selectedPane", json!(null)),
        ("inputReady", json!(true)),
        ("surface", json!("home")),
    ] {
        let mut bad = value.clone();
        bad[field] = invalid;
        let mut reader = Reader::default();
        assert!(
            reader.accept(&serde_json::to_vec(&bad)?).is_err(),
            "{field}"
        );
        let mut catalog = value.clone();
        catalog["snapshot"] = serde_json::Value::Null;
        catalog["historyOffset"] = json!(0);
        assert_eq!(
            reader
                .accept(&serde_json::to_vec(&catalog)?)?
                .history_offset,
            0
        );
    }
    Ok(())
}

#[test]
fn catalog_defaults_to_zero_history_and_never_accepts_broker_rows() -> anyhow::Result<()> {
    let mut value = history()?;
    let mut reader = Reader::default();
    assert!(reader.accept(&serde_json::to_vec(&value)?).is_err());
    value["snapshot"] = serde_json::Value::Null;
    value["historyOffset"] = json!(0);
    assert_eq!(
        reader.accept(&serde_json::to_vec(&value)?)?.history_offset,
        0
    );
    value["sequence"] = json!(2);
    value
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("object"))?
        .remove("historyOffset");
    assert_eq!(
        reader.accept(&serde_json::to_vec(&value)?)?.history_offset,
        0
    );
    Ok(())
}
