use super::*;
use serde_json::json;
#[test]
fn history_wire_is_optional_bounded_and_correlated() -> anyhow::Result<()> {
    let mut value: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../fixtures/browser-initial.json"
    ))?;
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)?
            .session_history
            .is_none()
    );
    let action = "11111111-1111-4111-8111-111111111111";
    value["sessionHistory"] = json!({"revision":1,"back":action,"forward":null});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_ok()
    );
    for revision in [0, 9_007_199_254_740_992u64] {
        value["sessionHistory"]["revision"] = json!(revision);
        assert!(
            Reader::default()
                .accept(&serde_json::to_vec(&value)?)
                .is_err()
        );
    }
    value["sessionHistory"]["revision"] = json!(1);
    value["sessionHistory"]["forward"] = json!(action);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    value["sessionHistory"]["forward"] = json!(null);
    value["sessionHistoryRejected"] =
        json!({"request":2,"fromRequest":0,"revision":1,"action":action});
    value["request"] = json!(0);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_ok()
    );
    value["sessionHistoryRejected"]["fromRequest"] = json!(1);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    value["sessionHistoryRejected"] = json!(null);
    value["sessionHistory"]["back"] = json!("not-a-capability");
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(Command::SessionHistory {
            request: 8,
            from_request: 7,
            revision: 1,
            action: action.into()
        })?,
        json!({"type":"session-history","request":8,"fromRequest":7,"revision":1,"action":action})
    );
    Ok(())
}
