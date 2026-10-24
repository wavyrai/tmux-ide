use super::*;
#[test]
fn binary_socket_commits_and_acks_before_ui_drain_without_changing_untouched_rows() {
    binary_socket_roundtrip(false);
}
#[test]
fn fragmented_binary_socket_preserves_commit_hashes_and_row_identity() {
    binary_socket_roundtrip(true);
}
fn binary_socket_roundtrip(fragmented: bool) {
    let (listener, options) = fixture();
    let (seed_tx, seed_rx) = bounded(1);
    let (patch_tx, patch_rx) = bounded(1);
    let (ack_tx, ack_rx) = bounded(1);
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept_encoding(listener, "semantic-binary-v1");
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("tmux_delivery/tests/binary-vectors.json")).unwrap();
        for (index, vector) in vectors.iter().take(2).enumerate() {
            let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
            send(
                &mut socket,
                json!({"type":"terminal-delivery-envelope","pane":"pane.test","envelope":{
                "type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":"pane.test","generation":INSTANCE,"incarnation":"pane:1","deliveryNonce":NONCE,"transactionId":TRANSACTION,"protocolVersion":1,"encoding":"semantic-binary-v1","frame":if index==0 {"seed"}else{"patch"},"baseRevision":if index==0 {Value::Null}else{json!(1)},"canonicalRevision":index+1,"canonicalStateHash":vector["canonicalHash"],"representationHash":vector["representationHash"],"representationBytes":bytes.len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true}}),
            );
            let header = serde_json::to_vec(
                &json!({"pane":"pane.test","transactionId":TRANSACTION,"index":0}),
            )
            .unwrap();
            let mut packet = b"TDC1".to_vec();
            packet.extend((header.len() as u32).to_be_bytes());
            packet.extend(header);
            packet.extend(bytes);
            if fragmented {
                fragmentation::send(&mut socket, &packet, index as u64 + 1);
            } else {
                socket.send(Message::Binary(packet.into())).unwrap();
            }
            let ack: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(ack["type"], "terminal-delivery-ack");
            assert_eq!(ack["ack"]["canonicalRevision"], index + 1);
            assert_eq!(
                ack["ack"]["representationHash"],
                vector["representationHash"]
            );
            assert_eq!(ack["ack"]["canonicalStateHash"], vector["canonicalHash"]);
            if index == 0 {
                seed_tx.send(()).unwrap();
                patch_rx.recv_timeout(WAIT).unwrap();
            }
        }
        ack_tx.send(()).unwrap();
        done_rx.recv_timeout(WAIT).unwrap();
        let _ = socket.read();
    });
    let session =
        NativeSession::spawn_offered(options, "workspace".into(), false, None, true, false)
            .unwrap();
    seed_rx.recv_timeout(WAIT).unwrap();
    let seed = session.snapshot("pane.test").unwrap().unwrap();
    patch_tx.send(()).unwrap();
    ack_rx.recv_timeout(WAIT).unwrap();
    let latest = session.snapshot("pane.test").unwrap().unwrap();
    assert!(Arc::ptr_eq(&seed.grid[0], &latest.grid[0]));
    assert!(!Arc::ptr_eq(&seed.grid[1], &latest.grid[1]));
    let drained = session.drain().unwrap();
    assert_eq!(drained.panes["pane.test"].identity.canonical_revision, 2);
    assert_eq!(drained.panes.len(), 1);
    session.cancel();
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}

#[path = "tmux_native_session_binary_tests/fragmentation.rs"]
mod fragmentation;
