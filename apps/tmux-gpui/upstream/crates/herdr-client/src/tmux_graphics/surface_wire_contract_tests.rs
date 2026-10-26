use super::*;

#[test]
fn shared_contract_vectors_admit_only_bounded_supported_storage() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/native-surface-offers.json"
    ))
    .unwrap();
    let valid = &vectors["cases"][0]["offer"];
    let mut committed = pane();
    committed.identity = Arc::new(CommittedIdentity {
        generation: valid["generation"].as_str().unwrap().into(),
        incarnation: valid["incarnation"].as_str().unwrap().into(),
        delivery_nonce: valid["deliveryNonce"].as_str().unwrap().into(),
        canonical_revision: valid["canonicalRevision"].as_u64().unwrap(),
        canonical_state_hash: valid["canonicalStateHash"].as_str().unwrap().into(),
    });
    for case in vectors["cases"].as_array().unwrap() {
        let mut pool = Pool::default();
        let result = accept(
            &serde_json::to_vec(&case["offer"]).unwrap(),
            "pane.native",
            &committed,
            &mut pool,
        );
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if result.is_err() {
            assert_eq!(pool.reserved_bytes(), 0);
        }
    }
}
