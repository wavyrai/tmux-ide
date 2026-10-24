#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
fn value() -> serde_json::Value {
    let snapshot: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../fixtures/snapshot.json")).unwrap();
    json!({"version":1,"connection":"c","sequence":1,"request":0,"surface":"workspace","inputReady":true,"sessions":[{"id":"s","label":"s"}],"panes":[{"id":"p","label":"p"}],"selectedSession":"s","selectedPane":"p","status":"ready","snapshot":snapshot,"copyRegion":{"id":"p","left":0,"top":0,"width":60,"height":20,"wrapped":vec![false;20]},"selectionIdentity":"a".repeat(64)})
}
#[test]
fn broker_selection_identity_never_authorizes_a_terminal_copy_surface() {
    let parse =
        |value: &serde_json::Value| Reader::default().accept(&serde_json::to_vec(value).unwrap());
    let mut valid = value();
    assert!(parse(&valid).is_err());
    valid.as_object_mut().unwrap().remove("selectionIdentity");
    assert!(parse(&valid).is_err());
    for identity in [
        "a".repeat(63),
        "A".repeat(64),
        "g".repeat(64),
        "a".repeat(65),
    ] {
        let mut invalid = value();
        invalid["selectionIdentity"] = json!(identity);
        assert!(parse(&invalid).is_err());
    }
    let mut invalid = value();
    invalid["copyRegion"] = json!(null);
    assert!(parse(&invalid).is_err());
    let mut invalid = value();
    invalid["surface"] = json!("home");
    assert!(parse(&invalid).is_err());
}
