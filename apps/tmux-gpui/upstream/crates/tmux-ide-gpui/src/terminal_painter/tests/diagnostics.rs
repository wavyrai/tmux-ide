use super::*;

#[test]
#[allow(clippy::unwrap_used)]
fn paint_timing_threshold_interval_and_reset() {
    let start = Instant::now();
    let mut diagnostics = PaintDiagnostics::new(start);
    assert!(diagnostics.record(start, SLOW_PAINT).is_none());
    assert!(
        diagnostics
            .record(
                start + REPORT_INTERVAL - Duration::from_nanos(1),
                Duration::from_millis(17)
            )
            .is_none()
    );
    let timing = diagnostics
        .record(start + REPORT_INTERVAL, Duration::from_millis(3))
        .unwrap();
    assert_eq!(timing.count, 3);
    assert_eq!(timing.total, Duration::from_millis(36));
    assert_eq!(timing.max, Duration::from_millis(17));
    assert_eq!(timing.slow_count, 1);
    let timing = diagnostics
        .record(start + REPORT_INTERVAL * 2, Duration::from_millis(2))
        .unwrap();
    assert_eq!(timing.count, 1);
    assert_eq!(timing.total, Duration::from_millis(2));
    assert_eq!(timing.max, Duration::from_millis(2));
    assert_eq!(timing.slow_count, 0);
}

#[test]
fn paint_errors_report_immediately_then_coalesce() {
    let start = Instant::now();
    let mut diagnostics = PaintDiagnostics::new(start);
    assert_eq!(diagnostics.take_errors(start, 0), None);
    assert_eq!(diagnostics.take_errors(start, 2), Some(2));
    assert_eq!(diagnostics.take_errors(start, 3), None);
    assert_eq!(
        diagnostics.take_errors(start + REPORT_INTERVAL - Duration::from_nanos(1), 4),
        None
    );
    assert_eq!(diagnostics.take_errors(start + REPORT_INTERVAL, 0), Some(7));
    assert_eq!(
        diagnostics.take_errors(start + REPORT_INTERVAL * 2, 0),
        None
    );
}
