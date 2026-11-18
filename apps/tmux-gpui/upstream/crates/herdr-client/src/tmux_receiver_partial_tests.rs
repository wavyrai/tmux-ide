#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Capability 122 (history on demand), against vectors made by the
//! TypeScript reference (tmux_delivery/tests/generate-partial-history-vectors.ts):
//! a partial seed, patches whose trim counts loaded rows only, and history
//! frames, each verified by the full canonical hash.
use super::*;
use base64::Engine;
use serde_json::{Value, json};

const NONCE: &str = "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c";
const ENCODINGS: [&str; 2] = ["semantic-compact-v1", "semantic-binary-v1"];

fn receiver(encoding: &str) -> Receiver {
    Receiver::new(
        Negotiated {
            alternate_screen_projection: None,
            partial_history: Some("tail-v1".into()),
            protocol_version: 1,
            encoding: encoding.into(),
            fallback_encoding: None,
            rich_placements: false,
            generation: "generation".into(),
            delivery_nonce: NONCE.into(),
        },
        "workspace".into(),
        "pane.test".into(),
    )
    .unwrap()
}
fn steps(encoding: &str) -> Vec<Value> {
    let all: Value = serde_json::from_str(include_str!(
        "tmux_delivery/tests/partial-history-vectors.json"
    ))
    .unwrap();
    all[encoding].as_array().unwrap().clone()
}
fn wire(step: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(step["wire"].as_str().unwrap())
        .unwrap()
}
fn envelope(encoding: &str, step: &Value, transaction: &str) -> Value {
    let bytes = wire(step);
    json!({"type":"terminal.delivery", "workspaceName":"workspace", "semanticPaneId":"pane.test",
        "generation":"generation", "incarnation":"pane:1", "deliveryNonce":NONCE,
        "transactionId":transaction,"protocolVersion":1,"encoding":encoding,
        "frame":step["frame"],"baseRevision":step["baseRevision"],
        "canonicalRevision":step["revision"],"canonicalStateHash":step["canonicalStateHash"],
        "representationHash":step["representationHash"],"representationBytes":bytes.len(),
        "chunkCount":bytes.len().div_ceil(CHUNK_BYTES).max(1),"canonicalEquivalent":true,
        "history":"partial","historyUnloaded":step["historyUnloaded"],"richPlacements":false})
}
fn deliver(r: &mut Receiver, encoding: &str, step: &Value, envelope: &Value) -> Result<Ack> {
    let transaction = envelope["transactionId"].as_str().unwrap().to_owned();
    r.begin(&serde_json::to_vec(envelope).unwrap())?;
    let bytes = wire(step);
    let mut ack = None;
    for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        ack = r.chunk(&transaction, index, chunk)?;
    }
    let _ = encoding;
    ack.ok_or(Error::Ordering)
}
fn transaction() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn unloaded(r: &Receiver) -> usize {
    r.snapshot().unwrap().history.unloaded_rows()
}
fn loaded(r: &Receiver) -> usize {
    r.snapshot().unwrap().history.materialized().unwrap().len()
}

#[test]
fn a_partial_seed_patches_and_history_frames_verify_against_the_full_hash() {
    for encoding in ENCODINGS {
        let mut r = receiver(encoding);
        let mut seen = Vec::new();
        for step in steps(encoding) {
            let ack = deliver(
                &mut r,
                encoding,
                &step,
                &envelope(encoding, &step, &transaction()),
            )
            .unwrap_or_else(|e| panic!("{encoding} {}: {e}", step["frame"]));
            assert_eq!(ack.canonical_revision, step["revision"].as_u64().unwrap());
            assert_eq!(
                ack.canonical_state_hash,
                step["canonicalStateHash"].as_str().unwrap()
            );
            seen.push((
                step["frame"].as_str().unwrap().to_owned(),
                unloaded(&r),
                loaded(&r),
            ));
        }
        assert_eq!(
            seen,
            [
                ("seed".into(), 300, 200),
                ("patch".into(), 280, 220),
                ("history".into(), 160, 340),
                ("patch".into(), 0, 335),
            ],
            "{encoding}"
        );
        assert!(r.snapshot().unwrap().history.is_complete());
        // A history frame keeps the revision.
        assert_eq!(r.revision(), Some(2));
    }
}

#[test]
fn a_request_names_the_committed_revision_and_the_unloaded_rows() {
    let encoding = ENCODINGS[0];
    let steps = steps(encoding);
    let mut r = receiver(encoding);
    assert!(r.history_request(500).is_none(), "nothing committed yet");
    deliver(
        &mut r,
        encoding,
        &steps[0],
        &envelope(encoding, &steps[0], &transaction()),
    )
    .unwrap();
    let request = serde_json::to_value(r.history_request(500).unwrap()).unwrap();
    assert_eq!(
        request,
        json!({"type":"terminal.delivery.history-request","workspaceName":"workspace",
            "semanticPaneId":"pane.test","generation":"generation","incarnation":"pane:1",
            "deliveryNonce":NONCE,"canonicalRevision":0,"unloadedRows":300,"maxRows":500})
    );
    assert!(r.history_request(0).is_none() && r.history_request(2001).is_none());
    for step in &steps[1..] {
        deliver(
            &mut r,
            encoding,
            step,
            &envelope(encoding, step, &transaction()),
        )
        .unwrap();
    }
    assert!(r.history_request(500).is_none(), "nothing left to load");
}

/// Any doubt fails the delivery: a wrong chunk row, a commitment that grows
/// on a patch, a history frame at another revision or without a partial
/// history, and a partial envelope on a stream that did not negotiate it.
#[test]
fn partial_history_refuses_what_does_not_verify() {
    for encoding in ENCODINGS {
        let steps = steps(encoding);
        let seeded = || {
            let mut r = receiver(encoding);
            for step in &steps[..2] {
                deliver(
                    &mut r,
                    encoding,
                    step,
                    &envelope(encoding, step, &transaction()),
                )
                .unwrap();
            }
            r
        };
        // The history chunk claims one row fewer than it proves.
        let mut r = seeded();
        let mut e = envelope(encoding, &steps[2], &transaction());
        e["historyUnloaded"]["rows"] = json!(161);
        assert!(
            deliver(&mut r, encoding, &steps[2], &e).is_err(),
            "{encoding} rows"
        );
        // ...or a different remaining digest.
        let mut r = seeded();
        let mut e = envelope(encoding, &steps[2], &transaction());
        e["historyUnloaded"]["digest"] = json!("0123456789abcdef");
        assert!(
            deliver(&mut r, encoding, &steps[2], &e).is_err(),
            "{encoding} digest"
        );
        // A history frame must stay at the client's revision.
        let mut r = seeded();
        let mut e = envelope(encoding, &steps[2], &transaction());
        e["baseRevision"] = json!(0);
        assert!(
            deliver(&mut r, encoding, &steps[2], &e).is_err(),
            "{encoding} base"
        );
        // A patch may not grow the unloaded rows.
        let mut r = seeded();
        deliver(
            &mut r,
            encoding,
            &steps[2],
            &envelope(encoding, &steps[2], &transaction()),
        )
        .unwrap();
        let mut e = envelope(encoding, &steps[3], &transaction());
        e["historyUnloaded"] = json!({"rows": 161, "digest": "0123456789abcdef"});
        assert!(
            deliver(&mut r, encoding, &steps[3], &e).is_err(),
            "{encoding} grow"
        );
        // Complete history on a partial stream, and partial on a plain one.
        let mut r = receiver(encoding);
        let mut e = envelope(encoding, &steps[0], &transaction());
        e["history"] = json!("complete");
        e.as_object_mut().unwrap().remove("historyUnloaded");
        assert!(
            deliver(&mut r, encoding, &steps[0], &e).is_err(),
            "{encoding} complete"
        );
        // A partial envelope without its commitment.
        let mut r = receiver(encoding);
        let mut e = envelope(encoding, &steps[0], &transaction());
        e.as_object_mut().unwrap().remove("historyUnloaded");
        assert!(
            deliver(&mut r, encoding, &steps[0], &e).is_err(),
            "{encoding} bare"
        );
        let mut plain = receiver(encoding);
        plain.negotiated.partial_history = None;
        let e = envelope(encoding, &steps[0], &transaction());
        assert!(
            deliver(&mut plain, encoding, &steps[0], &e).is_err(),
            "{encoding} plain"
        );
    }
}

#[test]
fn partial_history_is_negotiated_only_as_tail_v1_without_a_projection() {
    let negotiated = |partial: Option<&str>, projection: Option<&str>| Negotiated {
        alternate_screen_projection: projection.map(Into::into),
        partial_history: partial.map(Into::into),
        protocol_version: 1,
        encoding: "semantic-binary-v1".into(),
        fallback_encoding: None,
        rich_placements: false,
        generation: "generation".into(),
        delivery_nonce: NONCE.into(),
    };
    let new = |n| Receiver::new(n, "workspace".into(), "pane.test".into()).is_ok();
    assert!(new(negotiated(Some("tail-v1"), None)));
    assert!(!new(negotiated(Some("tail-v2"), None)));
    assert!(!new(negotiated(
        Some("tail-v1"),
        Some("deferred-history-v1")
    )));
}
