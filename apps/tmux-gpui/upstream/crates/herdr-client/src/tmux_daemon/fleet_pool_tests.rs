use super::*;
use crate::tmux_daemon::{CatalogSource, FleetCatalogPool};
fn empty_catalog_response(index: usize) -> String {
    response(&if matches!(index, 2 | 5) {
        serde_json::json!({"version":1,"servers":[]})
    } else {
        identity()
    })
}
fn await_events(pool: &mut FleetCatalogPool, count: usize) -> Vec<FleetCatalogEvent> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut events = Vec::new();
    while events.len() < count {
        events.extend(pool.poll().unwrap());
        assert!(Instant::now() < deadline, "fleet did not finish");
        thread::sleep(Duration::from_millis(5));
    }
    events
}
#[test]
fn one_held_machine_does_not_block_another_and_removed_reply_is_discarded() {
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let (slow_port, slow_peer) = peer_many(3, move |index| {
        if index == 2 {
            entered.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        empty_catalog_response(index)
    });
    let (fast_port, fast_peer) = peer_many(7, empty_catalog_response);
    let slow = Sandbox::new();
    let fast = Sandbox::new();
    let mut pool = FleetCatalogPool::default();
    let slow_id = pool
        .insert(
            "slow".into(),
            CatalogSource::Local(slow.record(&value(slow_port))),
        )
        .unwrap();
    let fast_id = pool
        .insert(
            "fast".into(),
            CatalogSource::Local(fast.record(&value(fast_port))),
        )
        .unwrap();
    pool.poll().unwrap();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    let events = await_events(&mut pool, 1);
    assert_eq!(events[0].route_id, "fast");
    assert_eq!(events[0].incarnation, fast_id);
    assert!(events[0].result.is_ok());
    assert_eq!(pool.incarnation("slow"), Some(slow_id));
    pool.remove("slow").unwrap();
    release.send(()).unwrap();
    slow_peer.join().unwrap();
    fast_peer.join().unwrap();
    assert!(pool.poll().unwrap().is_empty());
    assert!(!pool.busy());
    pool.shutdown().unwrap();
}
#[test]
fn replacing_route_changes_incarnation_and_idle_poll_does_no_io() {
    let (port, peer) = peer_many(7, empty_catalog_response);
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let mut pool = FleetCatalogPool::default();
    let old = pool
        .insert("local".into(), CatalogSource::Local(path.clone()))
        .unwrap();
    let events = await_events(&mut pool, 1);
    assert_eq!(events[0].incarnation, old);
    assert!(events[0].result.is_ok());
    assert!(!pool.busy());
    peer.join().unwrap();
    for _ in 0..10 {
        assert!(pool.poll().unwrap().is_empty());
    }
    pool.remove("local").unwrap();
    let new = pool
        .insert("local".into(), CatalogSource::Local(path))
        .unwrap();
    assert_ne!(old, new);
    // Remove before the first poll: the queued replacement performs no discovery.
    pool.remove("local").unwrap();
    assert!(!pool.busy());
}

#[test]
fn successful_catalog_grants_observation_and_failed_refresh_revokes_it() {
    let (port, peer) = peer_many(7, empty_catalog_response);
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let mut pool = FleetCatalogPool::default();
    let epoch = pool
        .insert("local".into(), CatalogSource::Local(path.clone()))
        .unwrap();
    let events = await_events(&mut pool, 1);
    let identity = events[0].result.as_ref().unwrap().identity.clone();
    peer.join().unwrap();
    assert!(
        matches!(pool.observation_source("local", epoch, &identity), Some(CatalogSource::Local(p)) if p == path)
    );
    let mut changed = identity.clone();
    changed.instance_id = uuid::Uuid::new_v4().to_string();
    assert!(pool.observation_source("local", epoch, &changed).is_none());
    pool.refresh("local").unwrap();
    let events = await_events(&mut pool, 1);
    assert!(events[0].result.is_err());
    assert!(pool.observation_source("local", epoch, &identity).is_none());
}
#[cfg(unix)]
#[test]
fn registry_observation_requires_current_connected_route_and_catalog() {
    use crate::tmux_daemon::{FleetRegistry, SavedMachineRegistry};
    let (port, peer) = peer_many(7, empty_catalog_response);
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let mut fleet = FleetRegistry::new(path.clone());
    fleet
        .reconcile(
            SavedMachineRegistry {
                version: 1,
                machines: vec![],
            },
            "remote",
        )
        .unwrap();
    let epoch = fleet.routes().next().unwrap().2;
    let deadline = Instant::now() + Duration::from_secs(5);
    let event = loop {
        if let Some(event) = fleet.poll().unwrap().pop() {
            break event;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    };
    let identity = event.result.unwrap().identity;
    peer.join().unwrap();
    assert!(
        matches!(fleet.agent_observation_source("local", epoch, &identity), Some(CatalogSource::Local(p)) if p == path)
    );
    assert!(
        fleet
            .agent_observation_source("local", uuid::Uuid::new_v4(), &identity)
            .is_none()
    );
    let disconnected = fleet.disconnect("local", epoch).unwrap().unwrap();
    assert!(
        fleet
            .agent_observation_source("local", epoch, &identity)
            .is_none()
    );
    assert!(
        fleet
            .agent_observation_source("local", disconnected, &identity)
            .is_none()
    );
    fleet.invalidate().unwrap();
    assert!(
        fleet
            .agent_observation_source("local", disconnected, &identity)
            .is_none()
    );
}
