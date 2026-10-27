use super::*;

#[test]
fn output_waits_for_final_marker_and_rejects_offset_changes() {
    let mut probe = ledger();
    let mut trial = arm();
    trial.kind = Kind::Output;
    start(&mut probe, trial);
    let source = scope();
    let marker = output_marker(&"a".repeat(32), None);
    assert!(!probe.after_paint(witness(&source, "PROBE-BURST:in-progress", &[0])));
    assert!(probe.after_paint(witness(&source, &marker, &[0])));
    assert_eq!(probe.drain()[0].kind, Kind::Output);

    let mut changed = arm();
    changed.kind = Kind::Output;
    changed.expected.viewport_offset = 1;
    assert_eq!(
        ledger().arm(
            changed,
            BeforeInput {
                scope: &source,
                visible_rows: &["", ""],
            }
        ),
        Err(ArmError::InvalidScope)
    );
}
