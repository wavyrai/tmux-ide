use super::*;
#[test]
fn binary_cell_offer_defaults_false_and_requires_boolean() {
    assert!(
        matches!(Event::parse(envelope().to_string().as_bytes()),Ok(Event::Open{capability,..}) if !capability.binary_cells)
    );
    for flag in [
        json!(true),
        json!(false),
        json!(null),
        json!(1),
        json!("true"),
    ] {
        let mut value = envelope();
        value["capability"]["binaryCells"] = flag.clone();
        let parsed = Event::parse(value.to_string().as_bytes());
        if let Some(enabled) = flag.as_bool() {
            assert!(
                matches!(parsed,Ok(Event::Open{capability,..}) if capability.binary_cells==enabled)
            );
        } else {
            assert!(parsed.is_err());
        }
    }
}
