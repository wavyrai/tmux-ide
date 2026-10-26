use super::*;
#[test]
fn process_accounting_bounds_slots_and_bytes_before_right_creation() {
    let mut counts = Counts::default();
    for _ in 0..PROCESS_FRAMES {
        assert!(counts.reserve(1));
    }
    assert!(!counts.reserve(1));
    assert_eq!(counts.frames, PROCESS_FRAMES);
    let mut counts = Counts::default();
    assert!(counts.reserve(PROCESS_BYTES));
    assert!(!counts.reserve(1));
    assert!(!counts.reserve(usize::MAX));
    assert_eq!(counts.bytes, PROCESS_BYTES);
    assert_eq!(counts.frames, 1);
}
