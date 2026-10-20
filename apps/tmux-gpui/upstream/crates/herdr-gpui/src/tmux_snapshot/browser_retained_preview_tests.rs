#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;

fn preview() -> serde_json::Value {
    json!({"version":1,"connection":"a","sequence":1,"request":7,
        "surface":"workspace","sessions":[],"panes":[],"selectedSession":null,
        "selectedPane":null,"inputReady":false,"status":"Loading","snapshot":null,
        "retainedPreview":{"snapshot":serde_json::from_str::<serde_json::Value>(
            include_str!("../../../../../fixtures/snapshot.json")).unwrap()}})
}
#[test]
fn retained_frame_is_display_only_and_catalog_can_arrive_before_live_frame() -> anyhow::Result<()> {
    let mut reader = Reader::default();
    let mut value = preview();
    let state = reader.accept(&serde_json::to_vec(&value)?)?;
    assert!(state.retained_preview && state.frame.is_some());
    assert!(!state.input_ready && state.selected_pane.is_none() && state.regions.is_empty());
    value["sequence"] = json!(2);
    value["sessions"] = json!([{"id":"s","label":"Session"}]);
    value["selectedSession"] = json!("s");
    value["panes"] = json!([{"id":"p","label":"Pane","windowId":"w"}]);
    value["sessionCatalogComplete"] = json!(true);
    value["preferredPane"] = json!("p");
    assert!(
        reader
            .accept(&serde_json::to_vec(&value)?)?
            .retained_preview
    );
    value["sequence"] = json!(3);
    value["retainedPreview"] = serde_json::Value::Null;
    value["snapshot"] = preview()["retainedPreview"]["snapshot"].clone();
    value["selectedPane"] = json!("p");
    value["preferredPane"] = serde_json::Value::Null;
    value["inputReady"] = json!(true);
    let live = reader.accept(&serde_json::to_vec(&value)?)?;
    assert!(!live.retained_preview && live.input_ready && live.frame.is_some());
    Ok(())
}
#[test]
fn retained_preview_rejects_live_authority_and_malformed_payloads() {
    for (key, value) in [
        ("surface", json!("home")),
        ("inputReady", json!(true)),
        ("selectedPane", json!("p")),
        ("historyOffset", json!(1)),
        ("snapshot", preview()["retainedPreview"]["snapshot"].clone()),
        (
            "copyRegion",
            json!({"id":"p","left":0,"top":0,"width":1,"height":1,"wrapped":[false]}),
        ),
        (
            "regions",
            json!([{"id":"p","left":0,"top":0,"width":1,"height":1}]),
        ),
        ("resizeToken", json!("11111111-1111-4111-8111-111111111111")),
        (
            "paneActions",
            json!({"id":"p","token":"11111111-1111-4111-8111-111111111111","zoomed":false}),
        ),
        ("retainedPreview", json!({"snapshot":null})),
        (
            "retainedPreview",
            json!({"snapshot":{},"capability":"forbidden"}),
        ),
        ("splitLayout", json!({})),
    ] {
        let mut publication = preview();
        publication[key] = value;
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&publication).unwrap())
                .is_err(),
            "{key}"
        );
    }
}

#[test]
fn retained_preview_obeys_existing_connection_sequence_and_request_fences() -> anyhow::Result<()> {
    let mut reader = Reader::default();
    let first = preview();
    reader.accept(&serde_json::to_vec(&first)?)?;
    assert!(reader.accept(&serde_json::to_vec(&first)?).is_err());
    let mut old_request = preview();
    old_request["sequence"] = json!(2);
    old_request["request"] = json!(6);
    assert!(reader.accept(&serde_json::to_vec(&old_request)?).is_err());
    let mut replaced = preview();
    replaced["sequence"] = json!(2);
    replaced["connection"] = json!("replacement");
    assert!(reader.accept(&serde_json::to_vec(&replaced)?).is_err());
    Ok(())
}
