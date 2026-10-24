#![allow(clippy::unwrap_used)]
use super::*;
#[path = "tests/output.rs"]
mod output;
fn scope() -> Scope {
    Scope {
        pane: "pane.a".into(),
        generation: "g".into(),
        incarnation: "i".into(),
        request: 1,
        cols: 110,
        rows: 2,
        viewport_offset: 0,
    }
}
fn arm() -> Arm {
    Arm {
        id: "input-0-gui".into(),
        nonce: "a".repeat(32),
        kind: Kind::Input,
        source: scope(),
        expected: scope(),
        marker_row: None,
        admitted_at_micros: 100,
    }
}
fn ledger() -> Ledger {
    Ledger::new(FixtureOptIn::enabled(true).unwrap())
}
fn start(ledger: &mut Ledger, arm: Arm) {
    let source = arm.source.clone();
    ledger
        .arm(
            arm,
            BeforeInput {
                scope: &source,
                visible_rows: &["FIXTURE READY", ""],
            },
        )
        .unwrap();
}
fn witness<'a>(scope: &'a Scope, text: &'a str, rows: &'a [u16]) -> PaintWitness<'a> {
    PaintWitness {
        scope,
        after_paint_at_micros: 1100,
        paint_sequence: 17,
        text,
        row: 0,
        column: 0,
        submitted_rows: rows,
        clipped: false,
    }
}
#[test]
fn only_actual_matching_visible_row_completes_once() {
    let mut ledger = ledger();
    start(&mut ledger, arm());
    let scope = scope();
    let marker = output_marker(&"a".repeat(32), None);
    assert!(!ledger.after_paint(witness(&scope, &marker, &[])));
    assert!(!ledger.after_paint(PaintWitness {
        column: 100,
        ..witness(&scope, &marker, &[0])
    }));
    assert!(!ledger.after_paint(PaintWitness {
        clipped: true,
        ..witness(&scope, &marker, &[0])
    }));
    assert!(ledger.after_paint(witness(&scope, &marker, &[0])));
    assert!(!ledger.after_paint(witness(&scope, &marker, &[0])));
    let records = ledger.drain();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].duration_micros, Some(1000));
    assert_eq!(records[0].admitted_at_micros, 100);
    assert_eq!(records[0].source, scope);
    assert_eq!(records[0].expected, scope);
    assert_eq!(records[0].witness.as_ref().unwrap().paint_sequence, 17);
    assert_eq!(records[0].outcome, Outcome::Completed);
    assert_eq!(
        ledger.arm(
            arm(),
            BeforeInput {
                scope: &scope,
                visible_rows: &["", ""]
            }
        ),
        Err(ArmError::DuplicateNonce)
    );
}
#[test]
fn scope_failure_retains_observed_identity_and_never_success_duration() {
    let mut ledger = ledger();
    start(&mut ledger, arm());
    let changed = Scope {
        incarnation: "new".into(),
        ..scope()
    };
    let marker = output_marker(&"a".repeat(32), None);
    assert!(!ledger.after_paint(witness(&changed, &marker, &[0])));
    let receipt = ledger.drain().remove(0);
    assert_eq!(receipt.outcome, Outcome::Failed(Failure::ScopeChanged));
    assert_eq!(receipt.witness.unwrap().scope, changed);
    assert_eq!(receipt.duration_micros, None);
}
#[test]
fn scroll_ignores_old_viewport_but_requires_exact_destination() {
    let mut ledger = ledger();
    let source = scope();
    let expected = Scope {
        viewport_offset: 10,
        ..source.clone()
    };
    start(
        &mut ledger,
        Arm {
            kind: Kind::Scroll,
            expected: expected.clone(),
            marker_row: Some(450),
            ..arm()
        },
    );
    let marker = output_marker(&"a".repeat(32), Some(450));
    assert!(!ledger.after_paint(witness(&source, &marker, &[0])));
    assert!(ledger.pending());
    assert!(ledger.after_paint(witness(&expected, &marker, &[0])));
    let receipt = ledger.drain().remove(0);
    assert_eq!(
        receipt.marker,
        "PROBE-ROW:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0450"
    );
    assert_eq!(receipt.source, source);
    assert_eq!(receipt.expected, expected);
}
#[test]
fn output_marker_is_absent_even_if_input_nonce_is_visible() {
    let mut ledger = ledger();
    let scope = scope();
    ledger
        .arm(
            arm(),
            BeforeInput {
                scope: &scope,
                visible_rows: &["PROBE-IN:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ""],
            },
        )
        .unwrap();
    assert!(ledger.pending());
    let mut other = Ledger::new(FixtureOptIn::enabled(true).unwrap());
    let marker = output_marker(&"a".repeat(32), None);
    other
        .arm(
            arm(),
            BeforeInput {
                scope: &scope,
                visible_rows: &[&marker, ""],
            },
        )
        .unwrap();
    assert_eq!(
        other.drain()[0].outcome,
        Outcome::Failed(Failure::MarkerAlreadyPresent)
    );
    assert!(!other.pending());
}
#[test]
fn incomplete_negative_control_fails_and_is_counted() {
    let mut ledger = ledger();
    let scope = scope();
    ledger
        .arm(
            arm(),
            BeforeInput {
                scope: &scope,
                visible_rows: &[""],
            },
        )
        .unwrap();
    assert_eq!(
        ledger.drain()[0].outcome,
        Outcome::Failed(Failure::NegativeControlIncomplete)
    );
    assert_eq!(
        ledger.arm(
            arm(),
            BeforeInput {
                scope: &scope,
                visible_rows: &["", ""]
            }
        ),
        Err(ArmError::DuplicateNonce)
    );
}
#[test]
fn timeout_and_clock_regression_are_failed_not_fast_samples() {
    for (at, failure) in [
        (99, Failure::ClockInvalid),
        (5_000_101, Failure::Timeout),
        (u64::MAX, Failure::ClockInvalid),
    ] {
        let mut ledger = ledger();
        start(&mut ledger, arm());
        ledger.tick(at);
        let receipt = ledger.drain().remove(0);
        assert_eq!(receipt.outcome, Outcome::Failed(failure));
        assert_eq!(receipt.duration_micros, None);
    }
}
#[test]
fn timeout_boundary_is_five_seconds_inclusive() {
    let mut ledger = ledger();
    start(&mut ledger, arm());
    ledger.tick(5_000_100);
    assert!(ledger.pending());
    ledger.tick(5_000_101);
    assert!(!ledger.pending());
}
#[test]
fn bounds_are_per_fixture_not_reset_by_draining() {
    let mut ledger = ledger();
    for n in 0..64 {
        start(
            &mut ledger,
            Arm {
                nonce: format!("{n:032x}"),
                ..arm()
            },
        );
        ledger.cancel(Failure::FixtureStopped, 100);
        assert_eq!(ledger.drain().len(), 1);
    }
    let scope = scope();
    assert_eq!(
        ledger.arm(
            arm(),
            BeforeInput {
                scope: &scope,
                visible_rows: &["", ""]
            }
        ),
        Err(ArmError::Exhausted)
    );
}
#[test]
fn one_pending_and_explicit_opt_in() {
    assert!(FixtureOptIn::enabled(false).is_none());
    let mut ledger = ledger();
    start(&mut ledger, arm());
    let scope = scope();
    assert_eq!(
        ledger.arm(
            Arm {
                nonce: "b".repeat(32),
                ..arm()
            },
            BeforeInput {
                scope: &scope,
                visible_rows: &["", ""]
            }
        ),
        Err(ArmError::Busy)
    );
}
#[test]
fn geometry_request_and_lifetime_are_all_exact() {
    for changed in [
        Scope {
            request: 2,
            ..scope()
        },
        Scope {
            cols: 111,
            ..scope()
        },
        Scope { rows: 3, ..scope() },
        Scope {
            pane: "other".into(),
            ..scope()
        },
        Scope {
            generation: "other".into(),
            ..scope()
        },
    ] {
        let mut ledger = ledger();
        start(&mut ledger, arm());
        let marker = output_marker(&"a".repeat(32), None);
        assert!(!ledger.after_paint(witness(&changed, &marker, &[0])));
        assert_eq!(
            ledger.drain()[0].outcome,
            Outcome::Failed(Failure::ScopeChanged)
        );
    }
}
#[test]
fn invalid_witness_cannot_retain_unbounded_identity() {
    let mut ledger = ledger();
    start(&mut ledger, arm());
    let invalid = Scope {
        pane: "x".repeat(513),
        ..scope()
    };
    let marker = output_marker(&"a".repeat(32), None);
    assert!(!ledger.after_paint(witness(&invalid, &marker, &[0])));
    let receipt = ledger.drain().remove(0);
    assert_eq!(receipt.outcome, Outcome::Failed(Failure::InvalidWitness));
    assert!(receipt.witness.is_none());
}
#[test]
fn queue_or_transport_failure_preserves_original_admission() {
    for reason in [Failure::InputRejected, Failure::TransportFailed] {
        let mut ledger = ledger();
        start(&mut ledger, arm());
        ledger.cancel(reason, 600);
        let receipt = ledger.drain().remove(0);
        assert_eq!(receipt.admitted_at_micros, 100);
        assert_eq!(receipt.duration_micros, None);
        assert_eq!(receipt.outcome, Outcome::Failed(reason));
    }
    assert_eq!(ENDPOINT, "input-admission-to-renderer-work-complete");
}
