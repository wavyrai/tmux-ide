use super::*;
fn response_at(index: usize) -> String {
    response(&if matches!(index, 2 | 5) {
        serde_json::json!({"version":1,"servers":[]})
    } else {
        identity()
    })
}
fn event(fleet: &mut FleetRegistry) -> FleetCatalogEvent {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut events = fleet.poll().unwrap();
        if !events.is_empty() {
            assert_eq!(events.len(), 1);
            return events.remove(0);
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn explicit_retry_recovers_failed_discovery_with_new_route_incarnation() {
    let sandbox = Sandbox::new();
    let (old_port, old_peer) = peer_many(7, response_at);
    let path = sandbox.record(&value(old_port));
    let mut fleet = FleetRegistry::new(path.clone());
    let registry = SavedMachineRegistry {
        version: 1,
        machines: vec![],
    };
    fleet.reconcile(registry.clone(), "remote").unwrap();
    let first = event(&mut fleet);
    assert_eq!(first.route_id, "local");
    assert!(first.result.is_ok());
    old_peer.join().unwrap();
    let (new_port, new_peer) = peer_many(7, response_at);
    fs::write(&path, b"{}").unwrap();
    fleet.refresh().unwrap();
    // A failed discovery remains an error; the pool does not auto-retry it.
    let failed = event(&mut fleet);
    assert_eq!(failed.incarnation, first.incarnation);
    assert!(matches!(failed.result, Err(Error::RecordFormat)));
    fs::write(&path, serde_json::to_vec(&value(new_port)).unwrap()).unwrap();
    fleet.reconcile(registry, "remote").unwrap();
    let renewed = fleet.retry("local", first.incarnation).unwrap().unwrap();
    let recovered = event(&mut fleet);
    assert_ne!(renewed, first.incarnation);
    assert_eq!(recovered.incarnation, renewed);
    assert!(recovered.result.is_ok());
    assert!(fleet.retry("local", first.incarnation).unwrap().is_none());
    assert!(!fleet.busy());
    new_peer.join().unwrap();
    fleet.invalidate().unwrap();
}
