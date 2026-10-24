use super::*;
#[test]
fn materialize_request_is_scoped_coalesced_and_has_no_input_authority_effect() {
    let (mut c, observed, response, peer) = fixture();
    assert!(!c.materialize_history("left").unwrap());
    let f: Value =
        serde_json::from_str(include_str!("tmux_delivery/tests/projection-vectors.json")).unwrap();
    let bytes: Vec<u8> = serde_json::from_value(f["vectors"][0]["bytes"].clone()).unwrap();
    let crate::tmux_delivery::ProjectionUpdate::Seed { snapshot, .. } =
        crate::tmux_delivery::decode_projection(&bytes).unwrap()
    else {
        panic!("seed")
    };
    let old = c.current["left"].clone();
    c.current.insert(
        "left".into(),
        Arc::new(CommittedPane {
            snapshot: Some(Arc::new(snapshot)),
            identity: old.identity.clone(),
        }),
    );
    let owns = c.owns(Authority::Input);
    assert!(c.materialize_history("left").unwrap());
    assert!(c.materialize_history("left").unwrap());
    let wire = observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(wire["type"], "terminal-projection-materialize");
    assert_eq!(wire["request"]["type"], "terminal.projection.materialize");
    assert_eq!(wire["request"]["semanticPaneId"], "left");
    assert_eq!(wire["request"]["deliveryNonce"], TOKEN);
    assert_eq!(wire["request"]["incarnation"], "birth-left");
    assert_eq!(
        wire["request"]["projectionStateHash"],
        f["vectors"][0]["projectionStateHash"]
    );
    assert_eq!(c.owns(Authority::Input), owns);
    assert!(observed.try_recv().is_err());
    c.retire();
    drop(response);
    peer.join().unwrap();
}
