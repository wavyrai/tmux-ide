#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
#[test]
fn ordered_capability_close_is_not_a_coalesced_catalog() {
    let (tx, rx) = mpsc::sync_channel(2);
    let mut reader = Reader::default();
    let bytes = serde_json::to_vec(&json!({"type":"native-terminal-close","version":1,"id":"b987f903-e864-43dd-8591-8d0a464ca6e8","request":3})).unwrap();
    accept_pipe(&bytes, &mut reader, &tx).unwrap();
    assert!(matches!(
        rx.try_recv().unwrap(),
        Incoming::Handoff(Event::Close { request: 3, .. })
    ));
}
#[test]
fn broker_catalog_cannot_claim_native_input_authority() {
    let (tx, rx) = mpsc::sync_channel(2);
    let mut reader = Reader::default();
    let bytes = serde_json::to_vec(&json!({"version":1,"connection":"a","sequence":1,"request":4,"inputReady":true,"sessions":[],"panes":[],"status":"Ready"})).unwrap();
    assert!(accept_pipe(&bytes, &mut reader, &tx).is_err());
    assert!(rx.try_recv().is_err());
}
#[test]
fn revocation_clears_all_native_pixels_and_grants() {
    let mut state = State {
        input_ready: true,
        selection_identity: Some("a".repeat(64)),
        resize_token: Some("stale".into()),
        ..State::default()
    };
    revoke(&mut None, &mut state);
    assert!(!state.input_ready);
    assert!(state.selection_identity.is_none());
    assert!(state.resize_token.is_none());
}

fn binary_frame(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut wire = b"TIGF\x01\x00\x00\x00".to_vec();
    wire[5] = kind;
    wire.extend(u32::try_from(body.len()).unwrap().to_be_bytes());
    wire.extend(body);
    wire
}
#[test]
fn native_binary_json_keeps_order_and_rejects_cell_and_image_frames_before_decode() {
    let close = serde_json::to_vec(&json!({"type":"native-terminal-close","version":1,"id":"b987f903-e864-43dd-8591-8d0a464ca6e8","request":3})).unwrap();
    let (tx, rx) = mpsc::sync_channel(4);
    let mut reader = Reader::default();
    let mut wire = binary_frame(1, &close);
    wire.extend(binary_frame(1, &close));
    // One-byte buffer exercises partial prefix/body handling through the production read loop.
    read_broker(
        &mut BufReader::with_capacity(1, wire.as_slice()),
        &mut reader,
        &tx,
        true,
    )
    .unwrap();
    assert!(matches!(
        rx.try_recv().unwrap(),
        Incoming::Handoff(Event::Close { request: 3, .. })
    ));
    assert!(matches!(
        rx.try_recv().unwrap(),
        Incoming::Handoff(Event::Close { request: 3, .. })
    ));
    for kind in [2, 3] {
        let wire = binary_frame(kind, b"deliberately invalid terminal payload");
        assert!(matches!(
            read_broker(&mut wire.as_slice(), &mut reader, &tx, true),
            Err(Error::Invalid("terminal payload on broker pipe"))
        ));
        assert!(rx.try_recv().is_err());
    }
    let partial = binary_frame(1, &close);
    assert!(read_broker(&mut &partial[..partial.len() - 1], &mut reader, &tx, true).is_err());
    assert!(rx.try_recv().is_err());
}
#[test]
fn broker_json_cells_are_rejected_before_terminal_decode_and_catalog_still_works() {
    let (tx, rx) = mpsc::sync_channel(2);
    let mut reader = Reader::default();
    let mut value = json!({"version":1,"connection":"a","sequence":1,"request":0,
        "inputReady":false,"sessions":[],"panes":[],"status":"Home",
        "snapshot":{"encoding":"invalid","grid":"private terminal content"}});
    assert!(matches!(
        accept_pipe(&serde_json::to_vec(&value).unwrap(), &mut reader, &tx),
        Err(Error::Invalid("broker terminal payload is unsupported"))
    ));
    assert!(rx.try_recv().is_err());
    value["snapshot"] = serde_json::Value::Null;
    accept_pipe(&serde_json::to_vec(&value).unwrap(), &mut reader, &tx).unwrap();
    assert!(matches!(rx.try_recv().unwrap(), Incoming::Catalog(_)));
}
