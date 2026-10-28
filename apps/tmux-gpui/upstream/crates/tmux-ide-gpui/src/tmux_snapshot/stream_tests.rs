use super::Reader;
use serde_json::json;
#[test]
fn rejects_late_state_after_unavailable_and_other_connections() -> anyhow::Result<()> {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../fixtures/snapshot.json"))?;
    let line = |id: &str, seq, snapshot| {
        serde_json::to_vec(&json!({"connection":id,"sequence":seq,"snapshot":snapshot}))
    };
    let mut reader = Reader::default();
    assert!(reader.accept(&line("a", 1, fixture.clone())?)?.is_some());
    assert!(reader.accept(&line("b", 2, fixture.clone())?).is_err());
    assert!(reader.accept(&line("a", 1, fixture.clone())?).is_err());
    assert!(
        reader
            .accept(&line("a", 4, serde_json::Value::Null)?)?
            .is_none()
    );
    assert!(reader.accept(&line("a", 5, fixture)?).is_err());
    Ok(())
}
