use super::super::*;
fn options() -> ConnectOptions {
    ConnectOptions {
        descriptor: serde_json::from_value(serde_json::json!({"protocolVersion":2,"webSocketUrl":"ws://127.0.0.1:4000/v2/terminal/pane-streams/redeem","subprotocol":SUBPROTOCOL,"redemptionTicket":"unused","daemonInstanceId":"unused","requestId":"unused","expiresAt":1,"panes":["pane.one"],"effectiveViewerMode":"read-only"})).unwrap(),
        origin:"http://127.0.0.1:4000".into(),host_client_id:"native.test".into(),
    }
}
fn packet(header: serde_json::Value, payload: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(&header).unwrap();
    let mut bytes = b"TDC1".to_vec();
    bytes.extend((header.len() as u32).to_be_bytes());
    bytes.extend(header);
    bytes.extend(payload);
    bytes
}
#[test]
fn binary_chunks_demultiplex_with_exact_scope_and_bounds() {
    let header = serde_json::json!({"pane":"pane.one","transactionId":"cc840bc1-d8af-4764-a586-c95befc44701","index":0});
    let bytes = packet(header.clone(), &[0, 128, 255]);
    assert!(
        matches!(wire::parse_binary(&bytes,&options()),Ok(Event::BinaryChunk { index:0,data,.. }) if data == [0,128,255])
    );
    assert!(matches!(
        wire::parse_binary(b"TGB1abcdefgh", &options()),
        Ok(Event::GraphicsBinary(_))
    ));
    for change in [
        serde_json::json!({"pane":"pane.unissued"}),
        serde_json::json!({"transactionId":"bad"}),
        serde_json::json!({"index":64}),
        serde_json::json!({"unknown":true}),
    ] {
        let mut h = header.clone();
        h.as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(wire::parse_binary(&packet(h, &[1]), &options()).is_err());
    }
    for length in 0..8 {
        assert!(wire::parse_binary(&bytes[..length], &options()).is_err());
    }
    assert!(wire::parse_binary(&packet(header, &vec![0; 256 * 1024 + 1]), &options()).is_err());
    assert!(wire::parse_binary(b"TDC1\xff\xff\xff\xff", &options()).is_err());
}
