use super::*;
fn packet(bytes: Vec<u8>) -> Message {
    let header =
        serde_json::to_vec(&json!({"pane":"pane.test","transactionId":TRANSACTION,"index":0}))
            .unwrap();
    let mut packet = b"TDC1".to_vec();
    packet.extend((header.len() as u32).to_be_bytes());
    packet.extend(header);
    packet.extend(bytes);
    Message::Binary(packet.into())
}
#[test]
fn projection_socket_receipts_partial_state_then_materializes_without_false_ack() {
    let (listener, options) = fixture();
    let (partial_tx, partial_rx) = bounded(1);
    let (advance_tx, advance_rx) = bounded(1);
    let (envelope_tx, envelope_rx) = bounded(1);
    let (full_tx, full_rx) = bounded(1);
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept_offered(listener, "semantic-binary-v1", true);
        let f: Value =
            serde_json::from_str(include_str!("tmux_delivery/tests/projection-vectors.json"))
                .unwrap();
        for (index, v) in f["vectors"].as_array().unwrap().iter().take(2).enumerate() {
            let bytes: Vec<u8> = serde_json::from_value(v["bytes"].clone()).unwrap();
            send(
                &mut socket,
                json!({"type":"terminal-projection-envelope","pane":"pane.test","envelope":{"type":"terminal.projection","workspaceName":"workspace","semanticPaneId":"pane.test","generation":INSTANCE,"incarnation":"pane:1","deliveryNonce":NONCE,"transactionId":TRANSACTION,"protocolVersion":1,"encoding":"alternate-projection-binary-v1","frame":if index==0 {"seed"}else{"patch"},"baseRevision":if index==0 {Value::Null}else{json!(7)},"canonicalRevision":7+index,"canonicalStateHash":v["canonicalStateHash"],"projectionStateHash":v["projectionStateHash"],"representationHash":v["representationHash"],"representationBytes":bytes.len(),"chunkCount":1,"canonicalEquivalent":false,"history":"deferred","richPlacements":true}}),
            );
            socket.send(packet(bytes)).unwrap();
            let receipt: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(receipt["type"], "terminal-projection-receipt");
            assert_eq!(receipt["receipt"]["type"], "terminal.projection.receipt");
            assert_eq!(receipt["receipt"]["canonicalRevision"], 7 + index);
        }
        partial_tx.send(()).unwrap();
        advance_rx.recv_timeout(WAIT).unwrap();
        let bytes: Vec<u8> = serde_json::from_value(f["materializedBytes"].clone()).unwrap();
        send(
            &mut socket,
            json!({"type":"terminal-delivery-envelope","pane":"pane.test","envelope":{"type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":"pane.test","generation":INSTANCE,"incarnation":"pane:1","deliveryNonce":NONCE,"transactionId":TRANSACTION,"protocolVersion":1,"encoding":"semantic-binary-v1","frame":"seed","baseRevision":null,"canonicalRevision":8,"canonicalStateHash":f["vectors"][1]["canonicalStateHash"],"representationHash":f["materializedRepresentationHash"],"representationBytes":bytes.len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true}}),
        );
        envelope_tx.send(()).unwrap();
        advance_rx.recv_timeout(WAIT).unwrap();
        socket.send(packet(bytes)).unwrap();
        let ack: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(ack["type"], "terminal-delivery-ack");
        assert_eq!(ack["ack"]["canonicalRevision"], 8);
        full_tx.send(()).unwrap();
        done_rx.recv_timeout(WAIT).unwrap();
        let _ = socket.read();
    });
    let session =
        NativeSession::spawn_offered(options, "workspace".into(), false, None, true, true).unwrap();
    partial_rx.recv_timeout(WAIT).unwrap();
    assert!(
        session
            .snapshot("pane.test")
            .unwrap()
            .unwrap()
            .history
            .materialized()
            .is_none()
    );
    advance_tx.send(()).unwrap();
    envelope_rx.recv_timeout(WAIT).unwrap();
    let deadline = Instant::now() + WAIT;
    loop {
        let update = session.drain().unwrap();
        if update.materializing.contains("pane.test") {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::yield_now();
    }
    assert!(
        session
            .snapshot("pane.test")
            .unwrap()
            .unwrap()
            .history
            .materialized()
            .is_none()
    );
    advance_tx.send(()).unwrap();
    full_rx.recv_timeout(WAIT).unwrap();
    assert!(
        session
            .snapshot("pane.test")
            .unwrap()
            .unwrap()
            .history
            .is_complete()
    );
    assert!(session.drain().unwrap().materializing.is_empty());
    session.cancel();
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}
