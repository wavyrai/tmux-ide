#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
fn publication(sequence: u64, seq: u64, delta: bool) -> Value {
    let mut snapshot: Value =
        serde_json::from_str(include_str!("../../../../../fixtures/snapshot.json")).unwrap();
    snapshot["encoding"] = json!(if delta { "rle-delta-v1" } else { "rle-v1" });
    snapshot["epoch"] = json!("epoch");
    snapshot["seq"] = json!(seq);
    snapshot["history"] = json!([]);
    if delta {
        snapshot.as_object_mut().unwrap().remove("grid");
        snapshot["baseSeq"] = json!(seq - 1);
        snapshot["changedRows"] = json!([]);
    } else {
        snapshot["grid"] = json!(vec![json!([false, [[60, "a", 1, 0, 0, 0]]]); 20]);
    }
    json!({"version":1,"inputReady":true,"connection":"a","sequence":sequence,"request":4,
        "sessions":[{"id":"s","label":"Session"}],"panes":[{"id":"p","label":"Pane"}],
        "selectedSession":"s","selectedPane":"p","status":"Ready","snapshot":snapshot})
}
fn accept(r: &mut Reader, v: Value) -> Result<State, Error> {
    r.accept(&serde_json::to_vec(&v).unwrap())
}
#[test]
fn full_and_delta_broker_payloads_rejected_without_advancing_reader() {
    for delta in [false, true] {
        let mut reader = Reader::default();
        assert!(accept(&mut reader, publication(1, 2, delta)).is_err());
        let mut metadata = publication(1, 2, delta);
        metadata["snapshot"] = Value::Null;
        metadata["inputReady"] = json!(false);
        assert!(accept(&mut reader, metadata.clone()).is_ok());
        assert!(accept(&mut reader, metadata).is_err());
    }
}
#[test]
fn malformed_terminal_payload_is_refused_before_grid_decode() {
    let mut reader = Reader::default();
    let mut value = publication(1, 1, false);
    value["snapshot"] = json!({"encoding":"unknown","grid":"private terminal content"});
    assert!(matches!(
        accept(&mut reader, value),
        Err(Error::Invalid("broker terminal payload is unsupported"))
    ));
}
