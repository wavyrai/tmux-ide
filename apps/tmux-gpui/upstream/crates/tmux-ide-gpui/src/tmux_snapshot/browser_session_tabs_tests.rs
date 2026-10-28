use super::*;
#[test]
fn legacy_optional_wire_and_exact_command_result() -> anyhow::Result<()> {
    let mut value: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../fixtures/browser-initial.json"
    ))?;
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)?
            .session_tabs
            .is_none()
    );
    value["sessionTabs"] = serde_json::json!({"request":0,"revision":1,"rows":[],"active":null,"pending":null,"next":null,"previous":null,"closeActive":null});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_ok()
    );
    value["sessionTabs"]["request"] = serde_json::json!(1);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    value["sessionTabs"] = serde_json::Value::Null;
    value["sessionTabResult"] = serde_json::json!({"request":2,"fromRequest":0,"revision":1,"action":"11111111-1111-4111-8111-111111111111","outcome":"closed"});
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_ok()
    );
    value["sessionTabResult"]["fromRequest"] = serde_json::json!(1);
    assert!(
        Reader::default()
            .accept(&serde_json::to_vec(&value)?)
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(Command::SessionTab {
            request: 8,
            from_request: 7,
            revision: 1,
            action: "22222222-2222-4222-8222-222222222222".into()
        })?,
        serde_json::json!({"type":"session-tab","request":8,"fromRequest":7,"revision":1,"action":"22222222-2222-4222-8222-222222222222"})
    );
    Ok(())
}
