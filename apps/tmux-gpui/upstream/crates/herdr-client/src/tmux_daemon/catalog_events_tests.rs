#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
fn identity() -> Value {
    json!({"protocolVersion":4,"productVersion":"2.9.12","instanceId":"4fb9a140-f18e-4395-930d-8e299121c0ce","startedAt":"2026-10-25T00:00:00Z","environmentId":"fixture"})
}
fn receive(
    lane: &mut CatalogEvents,
    frame: Value,
) -> Result<CatalogEventEffect, CatalogEventError> {
    lane.receive(&serde_json::to_vec(&frame).unwrap())
}
fn lane() -> CatalogEvents {
    CatalogEvents::new(serde_json::from_value(identity()).unwrap())
}
fn hello(lane: &mut CatalogEvents) {
    assert_eq!(
        receive(
            lane,
            json!({"type":"hello","daemon":identity(),"sessions":[],"eventSequence":10})
        )
        .unwrap(),
        CatalogEventEffect::Subscribe { after_sequence: 10 }
    );
}
fn ack() -> Value {
    json!({"type":"resource.interests-ack","interestRevision":1,"sequence":10,"unavailableInterests":[]})
}
fn live() -> CatalogEvents {
    let mut lane = lane();
    hello(&mut lane);
    assert_eq!(
        receive(&mut lane, ack()).unwrap(),
        CatalogEventEffect::Invalidate
    );
    assert!(lane.ready());
    lane
}
fn change(sequence: u64, resource: &str) -> Value {
    json!({"type":"resource.changed","sequence":sequence,"resource":resource,"workspaceName":null,"revision":0,"causeOperationId":null})
}
#[test]
fn owner_and_subscription_barriers_precede_live_notifications() {
    let mut lane = lane();
    hello(&mut lane);
    assert!(!lane.ready());
    let subscribe: Value = serde_json::from_str(&CatalogEvents::subscription(10).unwrap()).unwrap();
    assert_eq!(subscribe["legacyEvents"], false);
    assert_eq!(subscribe["sessions"], json!([]));
    assert_eq!(
        subscribe["interests"],
        json!([{"resource":"workspace-catalog","workspaceName":null},
            {"resource":"fleet-catalog","workspaceName":null}])
    );
    assert_eq!(
        receive(&mut lane, ack()).unwrap(),
        CatalogEventEffect::Invalidate
    );
    assert!(lane.ready());
    assert!(!lane.needs_fallback());
}
/// A daemon without fleet push still serves the workspace catalog; Home then
/// keeps its periodic fallback refresh.
#[test]
fn a_daemon_without_fleet_push_keeps_the_fallback() {
    let mut lane = lane();
    hello(&mut lane);
    assert!(lane.needs_fallback());
    let mut partial = ack();
    partial["unavailableInterests"] = json!([{"resource":"fleet-catalog","workspaceName":null}]);
    assert_eq!(
        receive(&mut lane, partial).unwrap(),
        CatalogEventEffect::Invalidate
    );
    assert!(lane.ready());
    assert!(lane.needs_fallback());
}
#[test]
fn mismatched_identity_and_duplicate_hello_retire_the_lane() {
    for field in [
        "protocolVersion",
        "productVersion",
        "instanceId",
        "startedAt",
        "environmentId",
    ] {
        let mut owner = identity();
        owner[field] = if field == "protocolVersion" {
            json!(3)
        } else {
            json!("foreign")
        };
        let mut lane = lane();
        assert!(
            receive(
                &mut lane,
                json!({"type":"hello","daemon":owner,"sessions":[]})
            )
            .is_err()
        );
        assert!(matches!(
            receive(&mut lane, ack()),
            Err(CatalogEventError::Retired)
        ));
    }
    let mut lane = live();
    assert!(
        receive(
            &mut lane,
            json!({"type":"hello","daemon":identity(),"sessions":[]})
        )
        .is_err()
    );
    assert!(!lane.ready());
}
#[test]
fn only_new_catalog_changes_or_sequence_gaps_invalidate() {
    let mut lane = live();
    assert_eq!(
        receive(&mut lane, change(11, "workspace-catalog")).unwrap(),
        CatalogEventEffect::Invalidate
    );
    assert_eq!(
        receive(&mut lane, change(11, "workspace-catalog")).unwrap(),
        CatalogEventEffect::Unchanged
    );
    assert_eq!(
        receive(&mut lane, change(10, "fleet-catalog")).unwrap(),
        CatalogEventEffect::Unchanged
    );
    assert_eq!(
        receive(&mut lane, json!({"type":"resource.observed","sequence":12})).unwrap(),
        CatalogEventEffect::Unchanged
    );
    assert_eq!(
        receive(&mut lane, change(13, "application-shell")).unwrap(),
        CatalogEventEffect::Unchanged
    );
    assert_eq!(
        receive(&mut lane, json!({"type":"resource.observed","sequence":15})).unwrap(),
        CatalogEventEffect::Invalidate
    );
    assert_eq!(
        receive(&mut lane, change(16, "fleet-catalog")).unwrap(),
        CatalogEventEffect::Invalidate
    );
}
#[test]
fn replay_overflow_forces_snapshot_and_resets_the_cursor() {
    let mut lane = live();
    assert_eq!(receive(&mut lane, json!({"type":"snapshot-required","afterSequence":10,"oldestAvailableSequence":25,"currentSequence":30,"reason":"journal-gap"})).unwrap(), CatalogEventEffect::Invalidate);
    assert_eq!(
        receive(&mut lane, change(29, "workspace-catalog")).unwrap(),
        CatalogEventEffect::Unchanged
    );
    assert_eq!(
        receive(&mut lane, change(31, "workspace-catalog")).unwrap(),
        CatalogEventEffect::Invalidate
    );
}
#[test]
fn unavailable_observers_and_wrong_ack_cannot_become_ready() {
    let mut missing = ack();
    missing["unavailableInterests"] =
        json!([{"resource":"workspace-catalog","workspaceName":null}]);
    let mut wrong = ack();
    wrong["interestRevision"] = json!(2);
    for frame in [missing, wrong] {
        let mut lane = lane();
        hello(&mut lane);
        assert!(receive(&mut lane, frame).is_err());
        assert!(!lane.ready());
    }
}
#[test]
fn malformed_oversized_or_out_of_order_input_fails_closed() {
    let mut before = lane();
    assert!(receive(&mut before, change(1, "workspace-catalog")).is_err());
    let mut oversized = live();
    assert!(oversized.receive(&vec![b' '; 65537]).is_err());
    for sequence in [0, MAX_SEQUENCE + 1] {
        assert!(receive(&mut live(), change(sequence, "workspace-catalog")).is_err());
    }
    let mut extra = change(11, "workspace-catalog");
    extra["extra"] = json!(true);
    let mut missing = change(11, "workspace-catalog");
    missing.as_object_mut().unwrap().remove("workspaceName");
    let mut operation = change(11, "workspace-catalog");
    operation["causeOperationId"] = json!("not-a-uuid");
    for frame in [extra, missing, operation] {
        assert!(receive(&mut live(), frame).is_err());
    }
}

#[test]
fn missing_required_nullable_cursor_and_null_environment_are_rejected() {
    assert!(
        receive(
            &mut live(),
            json!({"type":"snapshot-required", "afterSequence":10,
        "currentSequence":20,"reason":"journal-gap"})
        )
        .is_err()
    );
    let mut owner = identity();
    owner["environmentId"] = Value::Null;
    assert!(
        receive(
            &mut lane(),
            json!({"type":"hello","daemon":owner,"sessions":[]})
        )
        .is_err()
    );
}
fn resumed(after: u64, hello_sequence: u64) -> CatalogEvents {
    let mut lane = CatalogEvents::resume(serde_json::from_value(identity()).unwrap(), after);
    assert_eq!(
        receive(
            &mut lane,
            json!({"type":"hello","daemon":identity(),"sessions":[],"eventSequence":hello_sequence})
        )
        .unwrap(),
        CatalogEventEffect::Subscribe {
            after_sequence: after
        },
        "a resume subscribes after the kept cursor, not the daemon's current one"
    );
    lane
}
fn resumed_ack(sequence: u64) -> Value {
    json!({"type":"resource.interests-ack","interestRevision":1,"sequence":sequence,"unavailableInterests":[]})
}
/// Nothing changed during the drop: the barrier reports the lane current, and
/// no catalog read is asked for.
#[test]
fn a_resume_with_nothing_changed_costs_no_read() {
    let mut lane = resumed(10, 12);
    // Replayed changes to other resources don't touch the catalog.
    assert_eq!(
        receive(&mut lane, change(11, "workspace-files")).unwrap(),
        CatalogEventEffect::Unchanged
    );
    assert_eq!(
        receive(&mut lane, change(12, "application-shell")).unwrap(),
        CatalogEventEffect::Unchanged
    );
    assert_eq!(
        receive(&mut lane, resumed_ack(12)).unwrap(),
        CatalogEventEffect::Resumed
    );
    assert!(lane.ready());
    assert_eq!(lane.sequence(), 12);
}
/// A catalog change replayed from the journal asks for one read.
#[test]
fn a_replayed_catalog_change_invalidates() {
    let mut lane = resumed(10, 11);
    assert_eq!(
        receive(&mut lane, change(11, "fleet-catalog")).unwrap(),
        CatalogEventEffect::Invalidate
    );
    assert_eq!(
        receive(&mut lane, resumed_ack(11)).unwrap(),
        CatalogEventEffect::Resumed
    );
}
/// A cursor outside the daemon's journal (a gap, or a daemon that restarted
/// and counts from zero again) gets snapshot-required: a full read.
#[test]
fn a_cursor_outside_the_journal_falls_back_to_a_full_read() {
    for (after, hello, reason) in [(10, 400, "journal-gap"), (500, 3, "cursor-ahead")] {
        let mut lane = resumed(after, hello);
        assert_eq!(
            receive(
                &mut lane,
                json!({"type":"snapshot-required","afterSequence":after,
                    "oldestAvailableSequence":144,"currentSequence":hello,"reason":reason})
            )
            .unwrap(),
            CatalogEventEffect::Invalidate,
            "{reason}"
        );
        assert_eq!(lane.sequence(), hello);
    }
}
/// A resume never crosses daemons: a different identity in the hello fails.
#[test]
fn a_resume_refuses_a_different_daemon() {
    let mut lane = CatalogEvents::resume(serde_json::from_value(identity()).unwrap(), 10);
    let mut other = identity();
    other["instanceId"] = json!("00000000-0000-4000-8000-000000000000");
    assert!(matches!(
        receive(
            &mut lane,
            json!({"type":"hello","daemon":other,"sessions":[],"eventSequence":10})
        ),
        Err(CatalogEventError::Identity)
    ));
}
