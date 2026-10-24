use super::*;
#[test]
fn binary_receiver_ack_requires_exact_bytes_hash_and_committed_state() {
    let vectors: Vec<Value> =
        serde_json::from_str(include_str!("tmux_delivery/tests/binary-vectors.json")).unwrap();
    let mut receiver = receiver();
    receiver.negotiated.encoding = "semantic-binary-v1".into();
    for (index, v) in vectors.iter().enumerate() {
        let bytes: Vec<u8> = serde_json::from_value(v["bytes"].clone()).unwrap();
        let mut e = envelope(index);
        e["encoding"] = json!("semantic-binary-v1");
        e["representationBytes"] = json!(bytes.len());
        e["representationHash"] = v["representationHash"].clone();
        receiver.begin(&serde_json::to_vec(&e).unwrap()).unwrap();
        let ack = receiver.chunk(TRANSACTION, 0, &bytes).unwrap().unwrap();
        assert_eq!(
            ack.canonical_state_hash,
            v["canonicalHash"].as_str().unwrap()
        );
        assert_eq!(ack.canonical_revision, index as u64 + 1);
        assert_eq!(receiver.snapshot().is_none(), index == 4);
    }
    let mut receiver = super::receiver();
    receiver.negotiated.encoding = "semantic-binary-v1".into();
    let mut e = envelope(0);
    e["encoding"] = json!("semantic-binary-v1");
    // JSON bytes cannot masquerade as the negotiated binary representation.
    receiver.begin(&serde_json::to_vec(&e).unwrap()).unwrap();
    assert!(
        receiver
            .chunk(
                TRANSACTION,
                0,
                vectors[0]["wire"].as_str().unwrap().as_bytes()
            )
            .is_err()
    );
    assert!(receiver.snapshot().is_none());
}
