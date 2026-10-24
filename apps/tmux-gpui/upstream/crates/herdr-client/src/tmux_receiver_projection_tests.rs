use super::*;
fn projection_fixture() -> Value {
    serde_json::from_str(include_str!("tmux_delivery/tests/projection-vectors.json")).unwrap()
}
fn projected_receiver() -> Receiver {
    let mut r = receiver();
    r.negotiated.encoding = "semantic-binary-v1".into();
    r.negotiated.alternate_screen_projection = Some("deferred-history-v1".into());
    r
}
fn projection_envelope(index: usize) -> Value {
    let f = projection_fixture();
    let v = &f["vectors"][index];
    let bytes: Vec<u8> = serde_json::from_value(v["bytes"].clone()).unwrap();
    json!({"type":"terminal.projection","workspaceName":"workspace","semanticPaneId":"pane.test","generation":"generation","incarnation":"pane:1","deliveryNonce":NONCE,"transactionId":TRANSACTION,"protocolVersion":1,"encoding":"alternate-projection-binary-v1","frame":v["payload"]["frame"],"baseRevision":v["payload"]["baseRevision"],"canonicalRevision":v["payload"]["revision"],"canonicalStateHash":v["canonicalStateHash"],"projectionStateHash":v["projectionStateHash"],"representationHash":v["representationHash"],"representationBytes":bytes.len(),"chunkCount":bytes.len().div_ceil(CHUNK_BYTES),"canonicalEquivalent":false,"history":"deferred","richPlacements":true})
}
fn apply_projection(r: &mut Receiver, index: usize) -> ProjectionReceipt {
    r.begin_projection(&serde_json::to_vec(&projection_envelope(index)).unwrap())
        .unwrap();
    let bytes: Vec<u8> =
        serde_json::from_value(projection_fixture()["vectors"][index]["bytes"].clone()).unwrap();
    r.projection_chunk(TRANSACTION, 0, &bytes).unwrap().unwrap()
}
#[test]
fn projection_receipt_is_not_ack_and_complete_seed_materializes_same_revision() {
    let mut r = projected_receiver();
    let receipt = apply_projection(&mut r, 0);
    assert_eq!(
        serde_json::to_value(receipt).unwrap()["type"],
        "terminal.projection.receipt"
    );
    assert_eq!(
        r.revision(),
        None,
        "projection never advances complete ACK baseline"
    );
    let old = r.snapshot().cloned().unwrap();
    assert!(old.history.materialized().is_none());
    apply_projection(&mut r, 1);
    assert!(Arc::ptr_eq(&old.grid[0], &r.snapshot().unwrap().grid[0]));
    let f = projection_fixture();
    let bytes: Vec<u8> = serde_json::from_value(f["materializedBytes"].clone()).unwrap();
    let mut e = envelope(0);
    e["encoding"] = json!("semantic-binary-v1");
    e["canonicalRevision"] = json!(8);
    e["canonicalStateHash"] = f["vectors"][1]["canonicalStateHash"].clone();
    e["representationBytes"] = json!(bytes.len());
    e["representationHash"] = f["materializedRepresentationHash"].clone();
    r.begin(&serde_json::to_vec(&e).unwrap()).unwrap();
    let ack = r.chunk(TRANSACTION, 0, &bytes).unwrap().unwrap();
    assert_eq!(ack.canonical_revision, 8);
    assert!(r.snapshot().unwrap().history.is_complete());
    assert!(r.projection_receipt().is_none());
    assert!(
        r.begin_projection(&serde_json::to_vec(&projection_envelope(0)).unwrap())
            .is_err(),
        "complete state cannot silently downgrade"
    );
}
#[test]
fn projection_rejects_unoffered_interleaved_stale_and_hash_corruption() {
    let mut unoffered = receiver();
    assert!(
        unoffered
            .begin_projection(&serde_json::to_vec(&projection_envelope(0)).unwrap())
            .is_err()
    );
    let mut r = projected_receiver();
    r.begin_projection(&serde_json::to_vec(&projection_envelope(0)).unwrap())
        .unwrap();
    assert!(r.begin(&serde_json::to_vec(&envelope(0)).unwrap()).is_err());
    let mut r = projected_receiver();
    apply_projection(&mut r, 0);
    let mut bad = projection_envelope(1);
    bad["incarnation"] = json!("pane:0");
    assert!(
        r.begin_projection(&serde_json::to_vec(&bad).unwrap())
            .is_err()
    );
    let mut r = projected_receiver();
    let mut bad = projection_envelope(0);
    bad["canonicalStateHash"] = json!("0000000000000000");
    r.begin_projection(&serde_json::to_vec(&bad).unwrap())
        .unwrap();
    let bytes: Vec<u8> =
        serde_json::from_value(projection_fixture()["vectors"][0]["bytes"].clone()).unwrap();
    assert!(r.projection_chunk(TRANSACTION, 0, &bytes).is_err());
    assert!(r.snapshot().is_none());
}
#[test]
fn identical_projection_reseed_keeps_partial_lane_but_changed_root_same_revision_retires() {
    let mut r = projected_receiver();
    apply_projection(&mut r, 0);
    apply_projection(&mut r, 0);
    assert_eq!(r.projection_receipt().unwrap().canonical_revision, 7);
    assert_eq!(r.revision(), None);
    let mut bad = projection_envelope(0);
    bad["projectionStateHash"] = json!("0000000000000000");
    assert!(
        r.begin_projection(&serde_json::to_vec(&bad).unwrap())
            .is_err()
    );
    assert!(r.snapshot().is_none());
}
