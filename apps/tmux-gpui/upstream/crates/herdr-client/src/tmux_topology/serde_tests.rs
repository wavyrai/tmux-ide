#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};

// Exact names/nullability from packages/contracts/src/pane-stream.ts:
// PaneStreamLayoutFrameSchemaZ. In particular, modeKeys is optional, not nullable.
fn fixture() -> Value {
    json!({"type":"layout","semanticWindowId":"window.one","windowName":"Editor",
        "currentWindow":true,"cols":80,"rows":24,"zoomed":false,
        "paneBorderStatus":"top","modeKeys":"vi","panes":[{
            "pane":"pane.one","displayName":"Shell","displayNameSource":"process",
            "left":0,"top":0,"width":80,"height":24,"active":true}]})
}
#[test]
fn catalog_layout_serialization_matches_exact_typescript_field_contract() {
    for border in ["top", "bottom", "off"] {
        for mode in ["emacs", "vi"] {
            for source in ["manual", "agent", "process", "title", "generated"] {
                let mut expected = fixture();
                expected["paneBorderStatus"] = json!(border);
                expected["modeKeys"] = json!(mode);
                expected["panes"][0]["displayNameSource"] = json!(source);
                let layout: Layout = serde_json::from_value(expected.clone()).unwrap();
                layout.validate().unwrap();
                let serialized = serde_json::to_value(&layout).unwrap();
                assert_eq!(serialized, expected);
                assert_eq!(
                    serde_json::from_value::<Layout>(serialized).unwrap(),
                    layout
                );
            }
        }
    }
}
#[test]
fn older_layout_omits_optional_mode_keys_instead_of_serializing_invalid_null() {
    let mut older = fixture();
    older.as_object_mut().unwrap().remove("modeKeys");
    older.as_object_mut().unwrap().remove("paneBorderStatus");
    older["panes"][0]
        .as_object_mut()
        .unwrap()
        .remove("displayName");
    older["panes"][0]
        .as_object_mut()
        .unwrap()
        .remove("displayNameSource");
    let layout: Layout = serde_json::from_value(older).unwrap();
    layout.validate().unwrap();
    let output = serde_json::to_value(&layout).unwrap();
    assert!(!output.as_object().unwrap().contains_key("modeKeys"));
    assert_eq!(output["paneBorderStatus"], "off");
    assert!(output["panes"][0]["displayName"].is_null());
    assert!(output["panes"][0]["displayNameSource"].is_null());
    assert_eq!(serde_json::from_value::<Layout>(output).unwrap(), layout);
}
#[test]
fn unresolved_semantic_identities_remain_null_in_catalog_metadata() {
    let mut expected = fixture();
    expected["semanticWindowId"] = Value::Null;
    expected["windowName"] = Value::Null;
    expected["panes"][0]["pane"] = Value::Null;
    expected["panes"][0]["displayName"] = Value::Null;
    expected["panes"][0]["displayNameSource"] = Value::Null;
    let layout: Layout = serde_json::from_value(expected.clone()).unwrap();
    layout.validate().unwrap();
    assert_eq!(serde_json::to_value(layout).unwrap(), expected);
}
