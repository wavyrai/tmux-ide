use super::*;
use serde_json::json;
fn publication(sequence: u64, request: u64) -> serde_json::Value {
    json!({"version":1,"inputReady":false,"connection":"a","sequence":sequence,"request":request,
        "sessions":[{"id":"s","label":"Session"}],"panes":[],"selectedSession":"s",
        "selectedPane":null,"status":"Choose a pane","snapshot":null})
}
#[test]
fn rejects_replaced_helper_and_old_requests() -> anyhow::Result<()> {
    let mut reader = Reader::default();
    reader.accept(&serde_json::to_vec(&publication(1, 3))?)?;
    assert!(
        reader
            .accept(&serde_json::to_vec(&publication(2, 2))?)
            .is_err()
    );
    let mut replaced = publication(2, 3);
    replaced["connection"] = json!("b");
    assert!(reader.accept(&serde_json::to_vec(&replaced)?).is_err());
    reader.accept(&serde_json::to_vec(&publication(3, 4))?)?;
    Ok(())
}
#[test]
fn rejects_duplicate_choices_and_unselected_frames() -> anyhow::Result<()> {
    let mut value = publication(1, 0);
    value["sessions"] = json!([{"id":"s","label":"One"},{"id":"s","label":"Two"}]);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    let mut value = publication(1, 0);
    value["snapshot"] =
        serde_json::from_str(include_str!("../../../../../fixtures/snapshot.json"))?;
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    Ok(())
}
