#![allow(clippy::unwrap_used)]
use super::*;
fn snapshot() -> FleetCatalog {
    FleetCatalog {
        identity: herdr_client::tmux_daemon::CatalogIdentity {
            instance_id: uuid::Uuid::new_v4().to_string(),
            environment_id: None,
        },
        servers: vec![],
        sessions: vec![],
    }
}
#[test]
fn hidden_home_cancels_read_lane_without_replacing_the_source() {
    let source = CatalogSource::Local(PathBuf::from("/nonexistent-selected-watch-fixture"));
    let mut gate = Gate::default();
    gate.seed(&snapshot());
    gate.reader = Some(CatalogWorker::spawn_source(source.clone()).unwrap());
    assert!(gate.poll(&source, false, false).unwrap().is_none());
    assert!(gate.reader.is_none());
    assert!(gate.watch.is_none());
    assert!(gate.dirty);
    assert!(gate.last.is_some());
    assert!(gate.poll(&source, true, false).unwrap().is_none());
    assert!(gate.reader.is_none() && gate.watch.is_none());
}
#[test]
fn generation_change_discards_old_notifications_and_owner_shutdown_revokes_seed() {
    let mut gate = Gate::default();
    let old = snapshot();
    gate.seed(&old);
    gate.dirty = true;
    gate.failure = Some(herdr_client::tmux_daemon::Error::IdentityChanged);
    let new = snapshot();
    gate.seed(&new);
    assert!(!gate.dirty && gate.failure.is_none());
    assert_eq!(gate.last.as_ref().unwrap().identity, new.identity);
    let owner = Owner::new(CatalogSource::Local(PathBuf::from(
        "/nonexistent-selected-watch-fixture",
    )));
    owner.seed_catalog(&old).unwrap();
    owner.shutdown().unwrap();
    assert!(owner.seed_catalog(&new).is_err());
    assert!(owner.0.lock().unwrap().catalog.last.is_none());
}
