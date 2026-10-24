use super::*;
fn waiting() -> OwnerState {
    OwnerState {
        pending: Some(Pending {
            authorization: OwnerAuthorization {
                operation_id: "operation".into(),
                pane: "pane".into(),
                lifetime: Lifetime {
                    generation: "generation".into(),
                    incarnation: "incarnation".into(),
                },
            },
            deadline: 2000,
            submitted: false,
            geometry_requested: false,
        }),
    }
}
#[test]
fn grant_and_barrier_required_then_authorize_only_once() {
    let mut state = waiting();
    assert!(state.transition(1, true, true, false).is_none());
    assert!(state.transition(2, true, false, true).is_none());
    assert!(matches!(
        state.transition(3, true, true, true),
        Some(OwnerEvent::Authorized(_))
    ));
    assert!(state.busy());
    assert!(!state.waiting());
    assert!(state.transition(4, true, true, true).is_none());
    assert!(state.complete("other-operation", true).is_none());
    assert!(state.complete("operation", true).is_some());
    assert!(!state.busy());
    assert!(state.complete("operation", true).is_none());
}
#[test]
fn blur_cancels_unsent_but_preserves_submitted_correlation() {
    let mut state = waiting();
    assert!(
        state
            .cancel_waiting()
            .is_some_and(|c| c.outcome == OwnerOutcome::Cancelled && !c.submitted)
    );
    let mut state = waiting();
    state.transition(1, true, true, true);
    assert!(state.cancel_waiting().is_none());
    assert!(state.transition(2, false, false, false).is_none());
    assert!(
        state
            .complete("operation", false)
            .is_some_and(|c| c.outcome == OwnerOutcome::Rejected && c.submitted)
    );
}
#[test]
fn stale_lifetime_and_grant_timeout_never_emit_authorization() {
    let mut state = waiting();
    assert!(matches!(
        state.transition(1, false, true, true),
        Some(OwnerEvent::Completed(OwnerCompletion {
            outcome: OwnerOutcome::Stale,
            submitted: false,
            ..
        }))
    ));
    let mut state = waiting();
    assert!(matches!(
        state.transition(2000, true, true, true),
        Some(OwnerEvent::Completed(OwnerCompletion {
            outcome: OwnerOutcome::TimedOut,
            submitted: false,
            ..
        }))
    ));
}
#[test]
fn uncertain_http_timeout_is_bounded_and_not_replayed() {
    let mut state = waiting();
    state.transition(100, true, true, true);
    assert!(matches!(
        state.transition(12100, true, true, true),
        Some(OwnerEvent::Completed(OwnerCompletion {
            outcome: OwnerOutcome::TimedOut,
            submitted: true,
            ..
        }))
    ));
    assert!(state.transition(12101, true, true, true).is_none());
    assert!(state.complete("operation", true).is_none());
}
