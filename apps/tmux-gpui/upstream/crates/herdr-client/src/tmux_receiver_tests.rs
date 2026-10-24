#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use serde_json::{Value, json};

const NONCE: &str = "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c";
const TRANSACTION: &str = "cc840bc1-d8af-4764-a586-c95befc44701";
fn receiver() -> Receiver {
    Receiver::new(
        Negotiated {
            alternate_screen_projection: None,
            protocol_version: 1,
            encoding: "semantic-compact-v1".into(),
            fallback_encoding: None,
            rich_placements: true,
            generation: "generation".into(),
            delivery_nonce: NONCE.into(),
        },
        "workspace".into(),
        "pane.test".into(),
    )
    .unwrap()
}
fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!("tmux_delivery/tests/vectors.json")).unwrap()
}
fn envelope(index: usize) -> Value {
    let v = vectors();
    let bytes = v[index]["wire"].as_str().unwrap().as_bytes();
    json!({"type":"terminal.delivery", "workspaceName":"workspace", "semanticPaneId":"pane.test",
        "generation":"generation", "incarnation":"pane:1", "deliveryNonce":NONCE,
        "transactionId":TRANSACTION,"protocolVersion":1,"encoding":"semantic-compact-v1",
        "frame":if index == 0 {"seed"} else if index == 4 {"tombstone"} else {"patch"},
        "baseRevision":if index == 0 {Value::Null} else {json!(index)},
        "canonicalRevision":index + 1,"canonicalStateHash":v[index]["canonicalHash"],
        "representationHash":v[index]["representationHash"], "representationBytes":bytes.len(),
        "chunkCount":bytes.len().div_ceil(CHUNK_BYTES).max(1),"canonicalEquivalent":true,
        "history":if index == 4 {"not-applicable"} else {"complete"},"richPlacements":true})
}
fn apply(r: &mut Receiver, index: usize) -> Ack {
    let v = vectors();
    r.begin(&serde_json::to_vec(&envelope(index)).unwrap())
        .unwrap();
    r.chunk(
        TRANSACTION,
        0,
        v[index]["wire"].as_str().unwrap().as_bytes(),
    )
    .unwrap()
    .unwrap()
}
#[test]
fn ack_only_after_verified_commit_and_dirty_rows_share_the_baseline() {
    let mut r = receiver();
    let ack = apply(&mut r, 0);
    assert_eq!(ack.canonical_revision, 1);
    let old = r.snapshot().unwrap().clone();
    assert_eq!(apply(&mut r, 1).canonical_revision, 2);
    let new = r.snapshot().unwrap();
    assert!(Arc::ptr_eq(&old.grid[0], &new.grid[0]));
    assert!(!Arc::ptr_eq(&old.grid[1], &new.grid[1]));
    let wire = serde_json::to_value(ack).unwrap();
    assert_eq!(wire["type"], "terminal.delivery.ack");
    assert_eq!(wire["semanticPaneId"], "pane.test");
    assert_eq!(r.pending_bytes(), 0);
}
#[test]
fn wrong_identity_stale_revision_and_unexpected_transactions_retire() {
    for field in [
        "workspaceName",
        "semanticPaneId",
        "generation",
        "deliveryNonce",
        "encoding",
    ] {
        let mut r = receiver();
        let mut e = envelope(0);
        e[field] = json!("wrong");
        assert!(
            r.begin(&serde_json::to_vec(&e).unwrap()).is_err(),
            "{field}"
        );
        assert!(r.snapshot().is_none());
        assert!(matches!(r.begin(b"{}"), Err(Error::Retired)));
    }
    let mut r = receiver();
    apply(&mut r, 0);
    assert!(r.begin(&serde_json::to_vec(&envelope(0)).unwrap()).is_err());
    let mut r = receiver();
    r.begin(&serde_json::to_vec(&envelope(0)).unwrap()).unwrap();
    assert!(r.begin(&serde_json::to_vec(&envelope(0)).unwrap()).is_err());
}
#[test]
fn malformed_chunks_and_hashes_never_ack_or_expose_a_snapshot() {
    let v = vectors();
    let bytes = v[0]["wire"].as_str().unwrap().as_bytes();
    for (transaction, index, data) in [
        (NONCE, 0, bytes),
        (TRANSACTION, 1, bytes),
        (TRANSACTION, 0, &bytes[..bytes.len() - 1]),
    ] {
        let mut r = receiver();
        r.begin(&serde_json::to_vec(&envelope(0)).unwrap()).unwrap();
        assert!(r.chunk(transaction, index, data).is_err());
        assert!(r.snapshot().is_none());
    }
    for field in ["canonicalStateHash", "representationHash"] {
        let mut r = receiver();
        let mut e = envelope(0);
        e[field] = json!("0000000000000000");
        r.begin(&serde_json::to_vec(&e).unwrap()).unwrap();
        assert!(r.chunk(TRANSACTION, 0, bytes).is_err());
        assert!(r.snapshot().is_none());
    }
}
#[test]
fn transaction_bounds_and_payload_envelope_mismatch_are_rejected() {
    for (field, value) in [
        ("representationBytes", json!(MAX_BYTES + 1)),
        ("chunkCount", json!(0)),
        ("canonicalRevision", json!(MAX_REVISION + 1)),
        ("history", json!("truncated")),
    ] {
        let mut r = receiver();
        let mut e = envelope(0);
        e[field] = value;
        assert!(
            r.begin(&serde_json::to_vec(&e).unwrap()).is_err(),
            "{field}"
        );
    }
    let mut r = receiver();
    let mut e = envelope(0);
    e["canonicalRevision"] = json!(2);
    r.begin(&serde_json::to_vec(&e).unwrap()).unwrap();
    assert!(
        r.chunk(
            TRANSACTION,
            0,
            vectors()[0]["wire"].as_str().unwrap().as_bytes()
        )
        .is_err()
    );
}
#[test]
fn tombstone_cannot_be_resurrected_in_same_incarnation() {
    let mut r = receiver();
    for i in 0..5 {
        apply(&mut r, i);
    }
    assert!(r.snapshot().is_none());
    assert_eq!(r.revision(), Some(5));
    let mut e = envelope(0);
    e["canonicalRevision"] = json!(6);
    assert!(r.begin(&serde_json::to_vec(&e).unwrap()).is_err());
}

#[path = "tmux_receiver_binary_tests.rs"]
mod binary;

#[path = "tmux_receiver_projection_tests.rs"]
mod projection;
