use super::*;
#[test]
fn broker_metadata_schema_has_no_terminal_store_or_negotiation() -> Result<(), Error> {
    let mut reader = Reader::default();
    let bytes = br#"{"version":1,"connection":"a","sequence":1,"request":0,"inputReady":false,"sessions":[],"panes":[],"status":"Home"}"#;
    let state = reader.accept(bytes)?;
    assert!(state.frame.is_none() && state.graphics.is_empty() && !state.input_ready);
    Ok(())
}
