use super::*;

#[test]
fn reused_sequence_keeps_original_native_negotiation_scope() -> Result<(), Error> {
    let generation = Uuid::new_v4();
    let mut original = Control::new(generation, 123, 0, [1; 8])?;
    let replacement = Control::new(generation, 123, 1, [1; 8])?;
    original.fallback_frame(FallbackReason::Unsupported)?;
    let old: serde_json::Value =
        serde_json::from_str(&original.retirement_frame(Retirement { sequence: 1 })?)
            .map_err(Error::Schema)?;
    let new: serde_json::Value =
        serde_json::from_str(&replacement.retirement_frame(Retirement { sequence: 1 })?)
            .map_err(Error::Schema)?;
    assert_eq!(old["generation"], generation.to_string());
    assert_eq!(new["generation"], old["generation"]);
    assert_eq!(new["sequence"], old["sequence"]);
    assert_eq!(old["connectionNonce"], original.nonce.to_string());
    assert_eq!(new["connectionNonce"], replacement.nonce.to_string());
    assert_ne!(old["connectionNonce"], new["connectionNonce"]);
    original.close();
    assert!(matches!(
        original.retirement_frame(Retirement { sequence: 1 }),
        Err(Error::State)
    ));
    Ok(())
}
