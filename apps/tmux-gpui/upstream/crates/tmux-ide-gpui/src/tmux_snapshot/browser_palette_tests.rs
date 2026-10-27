use super::*;
use serde_json::json;
#[test]
fn optional_palette_wire_legacy_bounds_and_unknown_fields() -> anyhow::Result<()> {
    let mut value: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../fixtures/browser-initial.json"
    ))?;
    let legacy = Reader::default().accept(&serde_json::to_vec(&value)?)?;
    assert!(!legacy.palette_supported);
    assert!(legacy.palette_agents.is_none());
    value["paletteSupported"] = json!(true);
    value["paletteAgents"] = json!({"scope":1,"revision":1,"phase":"live","rows":[],"observedSessions":0,"totalSessions":0,"truncatedSessions":0,"truncatedRows":0,"note":null});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_ok()
    );
    for scope in [0, 9_007_199_254_740_992u64] {
        value["paletteAgents"]["scope"] = json!(scope);
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&value)?)
                .is_err()
        );
    }
    value["paletteAgents"]["scope"] = json!(1);
    value["paletteAgents"]["route"] = json!("forbidden");
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    value["paletteAgents"] = serde_json::Value::Null;
    value["paletteSelectionRejected"] = json!({"request":1,"fromRequest":1,"scope":1});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    value["paletteSelectionRejected"] = json!({"request":2,"fromRequest":1,"scope":1});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_ok()
    );
    Ok(())
}
