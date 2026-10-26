#![allow(clippy::unwrap_used)]
use super::*;
use crate::{
    tmux_delivery::{Update, decode_compact},
    tmux_native_session::CommittedIdentity,
};
use std::sync::Arc;
#[test]
fn producer_envelope_roundtrips_through_receiver_admission() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("tests/vectors.json")).unwrap();
    let Update::Seed { snapshot, .. } =
        decode_compact(vectors["cases"][0]["wire"].as_str().unwrap().as_bytes()).unwrap()
    else {
        panic!("seed");
    };
    let committed = CommittedPane {
        snapshot: Some(Arc::new(snapshot)),
        identity: Arc::new(CommittedIdentity {
            generation: Uuid::new_v4().to_string(),
            incarnation: "pane:1".into(),
            delivery_nonce: Uuid::new_v4().to_string(),
            canonical_revision: 1,
            canonical_state_hash: "0000000000000001".into(),
        }),
    };
    let frame = || Frame {
        sequence: 1,
        surface_id: Uuid::new_v4(),
        storage_ticket: Uuid::new_v4(),
        layout: Layout {
            width: 16,
            height: 16,
            stride: 256,
            allocation_bytes: 4096,
        },
        placement: Placement {
            row: 0,
            column: 0,
            rows: 1,
            columns: 1,
        },
    };
    let connection = Uuid::new_v4();
    let submission = Submission::new(connection, "pane.editor", &committed, frame()).unwrap();
    assert_eq!(submission.allocation_bytes, 4096);
    let value: serde_json::Value = serde_json::from_str(&submission.encoded).unwrap();
    assert_eq!(value["connection"], connection.to_string());
    let mut pool = super::super::surface_leases::Pool::default();
    let accepted = super::super::surface_offer::accept(
        value["offer"].to_string().as_bytes(),
        "pane.editor",
        &committed,
        &mut pool,
    )
    .unwrap();
    assert!(accepted.is_current("pane.editor", &committed));
    assert_eq!(accepted.layout().stride, 256);
    let mut invalid = frame();
    invalid.placement.row = 16384;
    assert!(Submission::new(connection, "pane.editor", &committed, invalid).is_err());
    let mut invalid = frame();
    invalid.layout.allocation_bytes = 1024;
    assert!(Submission::new(connection, "pane.editor", &committed, invalid).is_err());
}
