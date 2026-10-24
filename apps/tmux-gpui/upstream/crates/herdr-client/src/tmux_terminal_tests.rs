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
