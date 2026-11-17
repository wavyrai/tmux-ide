use super::*;
use base64::Engine;

/// A partial snapshot of `left` from the TypeScript reference's compact seed:
/// 200 loaded rows, 300 unloaded.
fn partial(c: &mut Controller) {
    let all: Value = serde_json::from_str(include_str!(
        "tmux_delivery/tests/partial-history-vectors.json"
    ))
    .unwrap();
    let seed = &all["semantic-compact-v1"][0];
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(seed["wire"].as_str().unwrap())
        .unwrap();
    let mut store = Store::default();
    store
        .apply_with(
            decode_compact(&bytes).unwrap(),
            seed["canonicalStateHash"].as_str().unwrap(),
            Some(crate::tmux_delivery::DeferredHistory {
                rows: 300,
                digest: seed["historyUnloaded"]["digest"].as_str().unwrap().into(),
            }),
        )
        .unwrap();
    let old = c.current["left"].clone();
    c.current.insert(
        "left".into(),
        Arc::new(CommittedPane {
            snapshot: store.snapshot().cloned(),
            identity: old.identity.clone(),
        }),
    );
}

#[test]
fn a_history_request_is_scoped_and_one_is_in_flight_per_pane() {
    let (mut c, observed, response, peer) = fixture();
    let now = Instant::now();
    // A complete history has nothing to ask for, and is never a projection.
    assert!(!c.request_history("left", now).unwrap());
    assert!(!c.materialize_history("left").unwrap());
    partial(&mut c);
    assert_eq!(c.unloaded_history("left"), 300);
    // A partial history never materializes as a projection.
    assert!(!c.materialize_history("left").unwrap());
    let owns = c.owns(Authority::Input);
    assert!(c.request_history("left", now).unwrap());
    assert!(c.request_history("left", now).unwrap(), "still in flight");
    let wire = observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        wire,
        json!({"type":"terminal-delivery-history-request","request":{
            "type":"terminal.delivery.history-request","workspaceName":"workspace",
            "semanticPaneId":"left","generation":GEN,"incarnation":"birth-left",
            "deliveryNonce":TOKEN,"canonicalRevision":1,"unloadedRows":300,"maxRows":500}})
    );
    assert!(observed.try_recv().is_err(), "one request in flight");
    assert_eq!(c.owns(Authority::Input), owns);
    // Unanswered, it may be asked again after a while.
    let before = c.history_requests["left"].at;
    assert!(
        c.request_history("left", now + Duration::from_secs(3))
            .unwrap()
    );
    assert!(c.history_requests["left"].at > before, "asked again");
    c.retire();
    drop(response);
    peer.join().unwrap();
}
