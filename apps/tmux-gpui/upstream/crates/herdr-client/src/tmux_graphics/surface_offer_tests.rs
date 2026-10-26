#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_delivery::{Update, decode_compact};
use serde_json::{Value, json};
fn pane() -> CommittedPane {
    let vectors: Value = serde_json::from_str(include_str!("tests/vectors.json")).unwrap();
    let Update::Seed { snapshot, .. } =
        decode_compact(vectors["cases"][0]["wire"].as_str().unwrap().as_bytes()).unwrap()
    else {
        panic!("seed expected")
    };
    CommittedPane {
        snapshot: Some(Arc::new(snapshot)),
        identity: Arc::new(CommittedIdentity {
            generation: "generation".into(),
            incarnation: "incarnation".into(),
            delivery_nonce: "nonce".into(),
            canonical_revision: 7,
            canonical_state_hash: "committed-hash".into(),
        }),
    }
}
fn offer() -> Value {
    json!({"type":"terminal-surface-offer", "version":1, "pane":"pane",
        "generation":"generation", "incarnation":"incarnation", "deliveryNonce":"nonce",
        "canonicalRevision":7,"canonicalStateHash":"committed-hash","sequence":1,
        "surfaceId":"b1c156b3-b7f0-46d5-9477-53548d6a61c9",
        "placement":{"row":0,"column":0,"rows":1,"columns":1},
        "storageTicket":"37398845-6fe0-42b9-b716-56b113a2c4c3",
        "format":"bgra8-straight", "width":16,"height":16,"stride":256,"allocationBytes":4096})
}
fn admit(value: &Value, pane: &CommittedPane, pool: &mut Pool) -> Result<Accepted, Error> {
    accept(&serde_json::to_vec(value).unwrap(), "pane", pane, pool)
}
#[test]
fn exact_commit_admits_and_native_storage_reference_controls_retirement() {
    let pane = pane();
    let mut pool = Pool::default();
    let admitted = admit(&offer(), &pane, &mut pool).unwrap();
    assert!(admitted.is_current("pane", &pane));
    assert_eq!(admitted.layout().bytes().unwrap(), 4096);
    let storage = admitted.storage_lease();
    drop(admitted);
    assert!(pool.next_retirement().is_none());
    drop(storage);
    assert_eq!(
        pool.next_retirement(),
        Some(super::super::surface_leases::Retirement { sequence: 1 })
    );
    assert_eq!(pool.reserved_bytes(), 0);
}
#[test]
fn every_scope_component_is_checked_before_reserving() {
    let pane = pane();
    let mut pool = Pool::default();
    for key in [
        "pane",
        "generation",
        "incarnation",
        "deliveryNonce",
        "canonicalStateHash",
        "canonicalRevision",
    ] {
        let mut value = offer();
        value[key] = if key == "canonicalRevision" {
            json!(8)
        } else {
            json!("stale")
        };
        assert!(
            matches!(admit(&value, &pane, &mut pool), Err(Error::Identity)),
            "{key}"
        );
        assert_eq!(pool.reserved_bytes(), 0);
    }
    assert!(admit(&offer(), &pane, &mut pool).is_ok());
}
#[test]
fn asynchronous_import_must_recheck_exact_commit_and_tombstones() {
    let old = pane();
    let mut pool = Pool::default();
    let admitted = admit(&offer(), &old, &mut pool).unwrap();
    assert!(!admitted.is_current("other-pane", &old));
    assert!(!admitted.is_current("pane", &pane()));
    let tombstone = CommittedPane {
        snapshot: None,
        identity: Arc::clone(&old.identity),
    };
    assert!(!admitted.is_current("pane", &tombstone));
    assert!(matches!(
        admit(&offer(), &tombstone, &mut pool),
        Err(Error::Identity)
    ));
}
#[test]
fn schema_format_size_and_sequence_fail_closed() {
    let pane = pane();
    let mut pool = Pool::default();
    for (key, value) in [
        ("version", json!(2)),
        ("format", json!("rgba")),
        ("type", json!("terminal-graphics")),
        ("width", json!(0)),
        ("allocationBytes", json!(1024)),
        ("stride", json!(1)),
        ("height", json!(16385)),
        ("sequence", json!(0)),
        ("sequence", json!(MAX_SAFE_INTEGER + 1)),
        ("storageTicket", json!(uuid::Uuid::nil())),
        ("surfaceId", json!(uuid::Uuid::nil())),
        ("path", json!("/private/untrusted")),
    ] {
        let mut changed = offer();
        changed[key] = value;
        assert!(admit(&changed, &pane, &mut pool).is_err(), "{key}");
        assert_eq!(pool.reserved_bytes(), 0);
    }
    assert!(matches!(
        accept(&vec![b' '; MAX_OFFER_BYTES + 1], "pane", &pane, &mut pool),
        Err(Error::Bounds)
    ));
    let first = admit(&offer(), &pane, &mut pool).unwrap();
    assert!(matches!(
        admit(&offer(), &pane, &mut pool),
        Err(Error::Reservation(
            super::super::surface_leases::Error::Sequence
        ))
    ));
    drop(first);
}
#[test]
fn handoff_is_one_use_and_wrong_rights_are_dropped() {
    use super::super::surface_handoff::Pending;
    let pane = pane();
    let mut pool = Pool::default();
    let mut pending = Pending::default();
    let admitted = admit(&offer(), &pane, &mut pool).unwrap();
    let ticket = admitted.storage_ticket();
    let now = std::time::Instant::now();
    pending.stage(admitted, now).unwrap();
    let right = Arc::new(());
    let weak = Arc::downgrade(&right);
    assert!(
        pending
            .bind(1, uuid::Uuid::nil(), right, "pane", &pane, now)
            .is_err()
    );
    assert!(weak.upgrade().is_none());
    assert_eq!(pool.reserved_bytes(), 4096);
    let (accepted, right) = pending
        .bind(1, ticket, Arc::new(()), "pane", &pane, now)
        .unwrap();
    assert!(accepted.is_current("pane", &pane));
    drop(right);
    let replay = Arc::new(());
    let weak = Arc::downgrade(&replay);
    assert!(pending.bind(1, ticket, replay, "pane", &pane, now).is_err());
    assert!(weak.upgrade().is_none());
    drop(accepted);
    assert!(pool.next_retirement().is_some());
}
#[test]
fn handoff_expiry_and_replacement_release_pending_reservations() {
    use super::super::surface_handoff::{Error as HandoffError, Pending};
    let old = pane();
    let mut pool = Pool::default();
    let mut pending = Pending::default();
    let admitted = admit(&offer(), &old, &mut pool).unwrap();
    let ticket = admitted.storage_ticket();
    let now = std::time::Instant::now();
    pending.stage(admitted, now).unwrap();
    let right = Arc::new(());
    let weak = Arc::downgrade(&right);
    assert!(matches!(
        pending.bind(1, ticket, right, "pane", &pane(), now),
        Err(HandoffError::Identity)
    ));
    assert!(weak.upgrade().is_none());
    assert!(pool.next_retirement().is_some());
    let mut value = offer();
    value["sequence"] = json!(2);
    pending
        .stage(admit(&value, &old, &mut pool).unwrap(), now)
        .unwrap();
    pending.expire(now + std::time::Duration::from_secs(5));
    assert!(pool.next_retirement().is_some());
    assert_eq!(pool.reserved_bytes(), 0);
}
#[path = "surface_placement_tests.rs"]
mod placement;
#[path = "surface_session_tests.rs"]
mod session_lifecycle;
#[path = "surface_wire_contract_tests.rs"]
mod wire_contract;
