#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use serde_json::{json, value::to_raw_value};
use tmux_stream::Event;

fn ready() -> Event {
    Event::Ready(
        serde_json::from_value(json!({"type":"ready","protocolVersion":2,
        "daemonInstanceId":"generation","requestId":"request","panes":["pane.test"],
        "effectiveViewerMode":"read-only"}))
        .unwrap(),
    )
}
fn state() -> TerminalState {
    TerminalState::new(
        "generation".into(),
        "workspace".into(),
        vec!["pane.test".into()],
    )
    .unwrap()
}
fn negotiate() -> Event {
    Event::DeliveryReady {
        pane: "pane.test".into(),
        negotiation: to_raw_value(&json!({"accepted":true,
        "negotiated":{"protocolVersion":1,"encoding":"semantic-compact-v1","richPlacements":true,
        "generation":"generation","deliveryNonce":"f8da3f73-66c3-4621-bf6f-547ee1d5fd1c"}}))
        .unwrap(),
    }
}
#[test]
fn readiness_and_negotiation_are_ordered_and_single_use() {
    let mut s = state();
    assert!(matches!(s.apply(negotiate()), Err(Error::Identity)));
    assert!(matches!(s.apply(ready()), Err(Error::Retired)));
    let mut s = state();
    assert!(matches!(s.apply(ready()), Ok(Outcome::Ready(_))));
    assert!(matches!(s.apply(negotiate()), Ok(Outcome::Pending)));
    assert!(matches!(s.apply(negotiate()), Err(Error::Identity)));
}
#[test]
fn commit_ack_preserves_unchanged_row_identity() {
    let vectors: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("tmux_delivery/tests/vectors.json")).unwrap();
    let mut s = state();
    s.apply(ready()).unwrap();
    s.apply(negotiate()).unwrap();
    let mut prior = None;
    for (index, v) in vectors.iter().take(2).enumerate() {
        let wire = v["wire"].as_str().unwrap();
        let envelope = json!({"type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":"pane.test",
            "generation":"generation","incarnation":"pane:1","deliveryNonce":"f8da3f73-66c3-4621-bf6f-547ee1d5fd1c",
            "transactionId":"cc840bc1-d8af-4764-a586-c95befc44701","protocolVersion":1,"encoding":"semantic-compact-v1",
            "frame":if index==0 {"seed"}else{"patch"},"baseRevision":if index==0 {serde_json::Value::Null}else{json!(1)},
            "canonicalRevision":index+1,"canonicalStateHash":v["canonicalHash"],"representationHash":v["representationHash"],
            "representationBytes":wire.len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true});
        assert!(matches!(
            s.apply(Event::Envelope {
                pane: "pane.test".into(),
                envelope: to_raw_value(&envelope).unwrap()
            }),
            Ok(Outcome::Pending)
        ));
        let result = s
            .apply(Event::Chunk {
                pane: "pane.test".into(),
                transaction_id: "cc840bc1-d8af-4764-a586-c95befc44701".into(),
                index: 0,
                data: STANDARD.encode(wire),
            })
            .unwrap();
        let Outcome::Updated {
            snapshot: Some(snapshot),
            changed_rows,
            ack,
            ..
        } = result
        else {
            panic!("expected verified commit")
        };
        assert_eq!(ack.canonical_revision, index as u64 + 1);
        if let Some(old) = prior {
            assert_eq!(changed_rows, vec![1]);
            assert!(Arc::ptr_eq(&old, &snapshot.grid[0]));
        }
        prior = Some(snapshot.grid[0].clone());
    }
    assert!(
        s.apply(Event::Control(
            to_raw_value(&json!({"type":"terminal-delivery-fault"})).unwrap()
        ))
        .is_err()
    );
    assert!(s.snapshot("pane.test").is_none());
}

#[path = "tmux_terminal_binary_tests.rs"]
mod binary;

#[path = "tmux_terminal_projection_tests.rs"]
mod projection;

#[test]
fn a_failure_names_the_pane_and_the_daemon_fault_reason() {
    let chunk = Event::Chunk {
        pane: "pane.one".into(),
        transaction_id: "t".into(),
        index: 0,
        data: String::new(),
    };
    assert_eq!(
        Failure::of(&chunk),
        Failure {
            pane: Some("pane.one".into()),
            fault: None
        }
    );
    let fault =
        |raw: &str| Failure::of(&Event::Control(RawValue::from_string(raw.into()).unwrap())).fault;
    assert_eq!(
        fault(
            r#"{"type":"terminal-delivery-fault","pane":"pane.one","fault":{"reason":"source-closed","message":"private"}}"#
        ),
        Some("source-closed")
    );
    assert_eq!(
        fault(r#"{"type":"terminal-delivery-fault","fault":{"reason":"<script>"}}"#),
        Some("other")
    );
    assert_eq!(fault(r#"{"type":"error"}"#), Some("error"));
    assert_eq!(fault(r#"{"type":"layout"}"#), None);
    let raw = r#"{"type":"terminal-delivery-fault","pane":"pane.one","fault":{"reason":"source-closed"}}"#;
    assert_eq!(
        Failure::of(&Event::Control(RawValue::from_string(raw.into()).unwrap())),
        Failure {
            pane: Some("pane.one".into()),
            fault: Some("source-closed")
        }
    );
}

#[test]
fn error_codes_name_the_check_without_content() {
    assert_eq!(Error::SourceClosed.code(), "source-closed");
    assert_eq!(
        Error::Delivery(tmux_receiver::Error::Ordering).code(),
        "delivery-ordering"
    );
    assert_eq!(
        Error::Delivery(tmux_receiver::Error::RepresentationHash).code(),
        "delivery-hash"
    );
}

const TXN: &str = "cc840bc1-d8af-4764-a586-c95befc44701";
fn seed_events(pane: &str, corrupt: bool, chunks: usize) -> (Event, Vec<Event>) {
    let vectors: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("tmux_delivery/tests/vectors.json")).unwrap();
    let v = &vectors[0];
    let wire = v["wire"].as_str().unwrap();
    let envelope = json!({"type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":pane,
        "generation":"generation","incarnation":"pane:1","deliveryNonce":"f8da3f73-66c3-4621-bf6f-547ee1d5fd1c",
        "transactionId":TXN,"protocolVersion":1,"encoding":"semantic-compact-v1",
        "frame":"seed","baseRevision":serde_json::Value::Null,
        "canonicalRevision":1,"canonicalStateHash":if corrupt {json!("0000000000000000")} else {v["canonicalHash"].clone()},
        "representationHash":v["representationHash"],
        "representationBytes":wire.len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true});
    let chunk = |index: u8| Event::Chunk {
        pane: pane.into(),
        transaction_id: TXN.into(),
        index,
        data: STANDARD.encode(wire),
    };
    (
        Event::Envelope {
            pane: pane.into(),
            envelope: to_raw_value(&envelope).unwrap(),
        },
        (0..chunks)
            .map(|i| chunk(u8::try_from(i).unwrap()))
            .collect(),
    )
}
fn two_panes() -> TerminalState {
    let mut s = TerminalState::new(
        "generation".into(),
        "workspace".into(),
        vec!["pane.a".into(), "pane.b".into()],
    )
    .unwrap();
    s.apply(Event::Ready(
        serde_json::from_value(json!({"type":"ready","protocolVersion":2,
        "daemonInstanceId":"generation","requestId":"request","panes":["pane.a","pane.b"],
        "effectiveViewerMode":"read-only"}))
        .unwrap(),
    ))
    .unwrap();
    for pane in ["pane.a", "pane.b"] {
        s.apply(Event::DeliveryReady {
            pane: pane.into(),
            negotiation: to_raw_value(&json!({"accepted":true,
            "negotiated":{"protocolVersion":1,"encoding":"semantic-compact-v1","richPlacements":true,
            "generation":"generation","deliveryNonce":"f8da3f73-66c3-4621-bf6f-547ee1d5fd1c"}}))
            .unwrap(),
        })
        .unwrap();
    }
    s
}

#[test]
fn a_rejected_delivery_is_a_nack_naming_its_flight_and_the_pane_accepts_a_reseed() {
    let mut s = two_panes();
    let (envelope, chunks) = seed_events("pane.a", true, 1);
    s.apply(envelope).unwrap();
    let outcome = s.apply(chunks.into_iter().next().unwrap()).unwrap();
    let Outcome::Reseed { pane, nack } = outcome else {
        panic!("expected a reseed");
    };
    assert_eq!(pane, "pane.a");
    assert_eq!(
        serde_json::to_value(&nack).unwrap(),
        json!({"type":"terminal.delivery.nack","workspaceName":"workspace","semanticPaneId":"pane.a",
        "generation":"generation","incarnation":"pane:1","deliveryNonce":"f8da3f73-66c3-4621-bf6f-547ee1d5fd1c",
        "transactionId":TXN,"reason":"hash-mismatch","appliedRevision":-1})
    );
    // The other pane, and the reseed of this one, commit as usual.
    let (envelope, chunks) = seed_events("pane.b", false, 1);
    s.apply(envelope).unwrap();
    assert!(matches!(
        s.apply(chunks.into_iter().next().unwrap()),
        Ok(Outcome::Updated { .. })
    ));
    let (envelope, chunks) = seed_events("pane.a", false, 1);
    s.apply(envelope).unwrap();
    assert!(matches!(
        s.apply(chunks.into_iter().next().unwrap()),
        Ok(Outcome::Updated { .. })
    ));
}

#[test]
fn chunks_already_framed_for_a_nacked_flight_are_ignored() {
    let mut s = two_panes();
    // An envelope that fails validation (a patch with no seed) is NACKed at once;
    // its chunk still arrives and must not count as a second failure.
    let (envelope, chunks) = seed_events("pane.a", false, 1);
    let mut raw: serde_json::Value = match &envelope {
        Event::Envelope { envelope, .. } => serde_json::from_str(envelope.get()).unwrap(),
        _ => unreachable!(),
    };
    raw["frame"] = json!("patch");
    raw["baseRevision"] = json!(0);
    let outcome = s
        .apply(Event::Envelope {
            pane: "pane.a".into(),
            envelope: to_raw_value(&raw).unwrap(),
        })
        .unwrap();
    assert!(matches!(&outcome, Outcome::Reseed { nack, .. } if nack.reason == "gap"));
    assert!(matches!(
        s.apply(chunks.into_iter().next().unwrap()),
        Ok(Outcome::Pending)
    ));
}

#[test]
fn a_pane_that_keeps_failing_fails_the_stream() {
    let mut s = two_panes();
    for _ in 0..3 {
        let (envelope, chunks) = seed_events("pane.a", true, 1);
        s.apply(envelope).unwrap();
        assert!(matches!(
            s.apply(chunks.into_iter().next().unwrap()),
            Ok(Outcome::Reseed { .. })
        ));
    }
    let (envelope, chunks) = seed_events("pane.a", true, 1);
    s.apply(envelope).unwrap();
    assert!(matches!(
        s.apply(chunks.into_iter().next().unwrap()),
        Err(Error::Delivery(_))
    ));
}

#[test]
fn a_commit_resets_the_pane_failure_count() {
    let mut s = two_panes();
    for _ in 0..3 {
        for corrupt in [true, true, true, false] {
            let (envelope, chunks) = seed_events("pane.a", corrupt, 1);
            s.apply(envelope).unwrap();
            s.apply(chunks.into_iter().next().unwrap()).unwrap();
        }
    }
}

#[test]
fn only_a_source_closed_fault_for_a_known_pane_is_pane_local() {
    let fault = |value: serde_json::Value| Event::Control(to_raw_value(&value).unwrap());
    let closed = |pane: &str| {
        fault(
            json!({"type":"terminal-delivery-fault","pane":pane,"fault":{"reason":"source-closed"}}),
        )
    };
    let mut s = two_panes();
    assert!(matches!(s.apply(closed("pane.a")), Ok(Outcome::Unavailable(p)) if p == "pane.a"));
    // Its late events are dropped; the other pane still commits.
    let (envelope, chunks) = seed_events("pane.a", false, 1);
    assert!(matches!(s.apply(envelope), Ok(Outcome::Pending)));
    assert!(matches!(
        s.apply(chunks.into_iter().next().unwrap()),
        Ok(Outcome::Pending)
    ));
    let (envelope, chunks) = seed_events("pane.b", false, 1);
    s.apply(envelope).unwrap();
    assert!(matches!(
        s.apply(chunks.into_iter().next().unwrap()),
        Ok(Outcome::Updated { .. })
    ));
    // The last pane closing ends the stream.
    assert!(matches!(
        s.apply(closed("pane.b")),
        Err(Error::SourceClosed)
    ));

    for frame in [
        json!({"type":"terminal-delivery-fault","pane":"pane.a","fault":{"reason":"protocol-violation"}}),
        json!({"type":"terminal-delivery-fault","fault":{"reason":"source-closed"}}),
        json!({"type":"terminal-delivery-fault","pane":"pane.zzz","fault":{"reason":"source-closed"}}),
        json!({"type":"error"}),
    ] {
        let mut s = two_panes();
        assert!(matches!(s.apply(fault(frame)), Err(Error::SourceClosed)));
    }
}

/// Review round 1, item 1 (PM decision: follow the design). A delivery for the
/// wrong stream (nonce, generation or workspace), an overlapping flight, or an
/// unreadable envelope fails the stream at once; none of them is NACKed.
#[test]
fn connection_level_faults_fail_the_stream_without_a_nack() {
    let envelope = |edit: &dyn Fn(&mut serde_json::Value)| {
        let (envelope, _) = seed_events("pane.a", false, 1);
        let Event::Envelope { envelope, .. } = envelope else {
            unreachable!()
        };
        let mut raw: serde_json::Value = serde_json::from_str(envelope.get()).unwrap();
        edit(&mut raw);
        Event::Envelope {
            pane: "pane.a".into(),
            envelope: to_raw_value(&raw).unwrap(),
        }
    };
    for (field, value) in [
        (
            "deliveryNonce",
            json!("00000000-0000-4000-8000-000000000000"),
        ),
        ("generation", json!("another-generation")),
        ("workspaceName", json!("another-workspace")),
    ] {
        let mut s = two_panes();
        let result = s.apply(envelope(&|raw| raw[field] = value.clone()));
        assert!(
            matches!(result, Err(Error::Delivery(tmux_receiver::Error::Identity))),
            "{field}"
        );
    }

    let mut s = two_panes();
    s.apply(envelope(&|_| {})).unwrap();
    assert!(matches!(
        s.apply(envelope(&|_| {})),
        Err(Error::Delivery(tmux_receiver::Error::Overlap))
    ));

    let mut s = two_panes();
    assert!(matches!(
        s.apply(Event::Envelope {
            pane: "pane.a".into(),
            envelope: to_raw_value(&json!({"type": "terminal.delivery"})).unwrap(),
        }),
        Err(Error::Delivery(tmux_receiver::Error::Envelope(_)))
    ));
}
