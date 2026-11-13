#![allow(clippy::unwrap_used)]
use super::*;
fn snapshot() -> FleetCatalog {
    FleetCatalog {
        service_version: None,
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
/// A drop keeps the catalog and its cursor and connects again only when
/// Home's retry is due; the retry then resumes after the cursor.
#[test]
fn a_dropped_lane_waits_for_the_retry_then_resumes() {
    let source = CatalogSource::Local(PathBuf::from("/nonexistent-selected-watch-fixture"));
    let mut gate = Gate::default();
    gate.seed(&snapshot());
    gate.cursor = Some(41);
    gate.reader = Some(CatalogWorker::spawn_source(source.clone()).unwrap());
    gate.drop_link();
    assert!(gate.reader.is_none() && gate.watch.is_none());
    assert!(gate.dirty, "a read lost to the drop is read again after it");
    assert!(gate.last.is_some() && gate.cursor == Some(41));
    assert!(gate.poll(&source, true, true).unwrap().is_none());
    assert!(gate.watch.is_none(), "nothing connects before the retry");
    assert!(gate.release());
    assert!(gate.recovering && !gate.held);
    assert!(!gate.release(), "one release per drop");
    gate.poll(&source, true, true).unwrap();
    assert!(gate.watch.is_some(), "the retry connects again");
}
/// With no kept catalog there is nothing to resume: Home reads from scratch.
#[test]
fn a_reset_lane_cannot_resume() {
    let mut gate = Gate::default();
    gate.seed(&snapshot());
    gate.cursor = Some(41);
    gate.reset();
    gate.drop_link();
    assert!(!gate.release());
    assert!(gate.cursor.is_none());
}
/// The cursor is the start of the last completed read, never a sequence the
/// catalog may not reflect yet.
#[test]
fn the_cursor_is_the_start_of_the_last_completed_read() {
    let mut gate = Gate::default();
    gate.seed(&snapshot());
    gate.read_started(Some(7));
    assert_eq!(gate.cursor, None, "not before the read completes");
    gate.read_completed();
    assert_eq!(gate.cursor, Some(7));
    // A read lost to a drop never moves the cursor.
    gate.read_started(Some(9));
    gate.reader = Some(
        CatalogWorker::spawn_source(CatalogSource::Local(PathBuf::from(
            "/nonexistent-selected-watch-fixture",
        )))
        .unwrap(),
    );
    gate.drop_link();
    gate.read_completed();
    assert_eq!(gate.cursor, Some(7));
    // A read with no live lane keeps the older cursor.
    gate.read_started(None);
    gate.read_completed();
    assert_eq!(gate.cursor, Some(7));
}
/// Through poll: the cursor is the lane's sequence when the read was
/// submitted, even when the lane moves on before the read completes; a read
/// started on a lane that isn't live never sets one (review of #362: P07, P08).
#[test]
fn poll_samples_the_cursor_before_the_read_not_after() {
    let source = CatalogSource::Local(PathBuf::from("/nonexistent-selected-watch-fixture"));
    let mut gate = Gate::default();
    let snapshot = snapshot();
    gate.seed(&snapshot);
    gate.watch = Some(CatalogWatchWorker::detached(5));
    gate.dirty = true;
    // A change lands the moment the read is submitted, before poll returns:
    // sampling after the submit would record 6.
    gate.advance_after_submit = Some(6);
    assert!(gate.poll(&source, true, true).unwrap().is_none());
    assert!(gate.reader.is_some(), "the read was submitted");
    assert_eq!(gate.watch.as_ref().unwrap().read_start(), Some(6));
    gate.reader.take();
    gate.on_read(Ok(CatalogResult::FleetCatalog(snapshot.clone())))
        .unwrap();
    assert_eq!(gate.cursor, Some(5), "the read reflects 5, not 6");
    // A lane that isn't live gives no cursor for the next read.
    gate.watch.as_ref().unwrap().cancel();
    gate.dirty = true;
    gate.poll(&source, true, true).unwrap();
    gate.reader.take();
    gate.on_read(Ok(CatalogResult::FleetCatalog(snapshot)))
        .unwrap();
    assert_eq!(gate.cursor, Some(5));
}

fn away(servers: Vec<ServerRegistration>) -> FleetCatalog {
    FleetCatalog {
        servers,
        ..snapshot()
    }
}
fn registered(online: bool) -> ServerRegistration {
    if online {
        ServerRegistration::Online {
            label: "default".into(),
            scope: ServerScope {
                server_id: "server".into(),
                generation: "generation".into(),
            },
        }
    } else {
        ServerRegistration::Offline {
            label: "default".into(),
            server_id: "other".into(),
        }
    }
}

/// Soak, 12 Nov 2026: the tmux server was killed and started again. The
/// 2.9.22 daemon listed it offline, the app showed "Create a local session to
/// begin", and nothing read the catalog again until someone refreshed.
#[test]
fn a_catalog_with_a_server_away_reads_itself_again_with_a_growing_wait() {
    for servers in [
        vec![registered(false)],
        vec![registered(true), registered(false)],
        vec![],
    ] {
        let mut gate = Gate::default();
        gate.seed(&away(servers));
        let start = Instant::now();
        assert!(!gate.recheck_due(start), "read again at once");
        let mut waits = Vec::new();
        let mut now = start;
        for _ in 0..6 {
            let wait = gate.recheck_wait(now).unwrap();
            waits.push(wait.as_secs());
            assert!(!gate.recheck_due(now + wait - Duration::from_millis(1)));
            now += wait;
            assert!(gate.recheck_due(now));
        }
        assert_eq!(waits, [5, 10, 20, 40, 60, 60]);
    }
}

#[test]
fn a_catalog_with_every_server_online_is_never_read_again_by_the_clock() {
    let mut gate = Gate::default();
    assert!(!gate.recheck_due(Instant::now()), "no catalog is kept");
    gate.seed(&away(vec![registered(true)]));
    let now = Instant::now();
    assert!(!gate.recheck_due(now));
    assert!(!gate.recheck_due(now + Duration::from_secs(3600)));
    assert!(gate.recheck_wait(now).is_none());
}

/// The count belongs to what is away now, and to a window that shows it.
#[test]
fn a_changed_catalog_or_a_hidden_window_starts_the_wait_over() {
    let source = CatalogSource::Local(PathBuf::from("/nonexistent-selected-watch-fixture"));
    let mut gate = Gate::default();
    gate.seed(&away(vec![registered(false)]));
    let now = Instant::now();
    gate.recheck_due(now);
    assert!(gate.recheck_due(now + Duration::from_secs(5)));
    assert_eq!(
        gate.recheck_wait(now + Duration::from_secs(5))
            .unwrap()
            .as_secs(),
        10
    );
    // Hidden: nothing is due, and the actor is not woken for it.
    assert!(gate.poll(&source, false, false).unwrap().is_none());
    assert!(gate.recheck_wait(Instant::now()).is_none());
    // The server came back in a read: the next away server waits 5 s again.
    gate.recheck_due(Instant::now());
    let mut back = away(vec![registered(true), registered(false)]);
    back.identity = gate.last.as_ref().unwrap().identity.clone();
    assert!(matches!(
        gate.on_read(Ok(CatalogResult::FleetCatalog(back))).unwrap(),
        Some(Notice::Changed(_))
    ));
    assert!(gate.recheck.is_none());
    // A due read is asked for through the same quiet lane as a change.
    gate.recheck = Some((Instant::now(), 0));
    gate.held = true;
    assert!(gate.poll(&source, true, true).unwrap().is_none());
    assert!(gate.reader.is_some(), "the due read was not started");
}
