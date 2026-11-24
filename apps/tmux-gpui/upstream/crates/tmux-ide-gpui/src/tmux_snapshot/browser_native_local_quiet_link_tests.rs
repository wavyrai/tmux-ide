#![allow(clippy::unwrap_used)]
//! Card #876: on a quiet, healthy link Home and an open session's sidebar
//! hold one catalog connection. Sending the window to the background and
//! back (switching apps) must not reconnect, re-read or wipe anything. When
//! the link really fails, the lane is retried like a session stream's: at once
//! on wake or a network change, with the rows kept as last known meanwhile.
use super::*;
use crate::tmux_snapshot::connection::network_watch;
use super::super::super::agents::quiet_link_fixture::{
    self, presence, snapshot,
};
use herdr_client::tmux_daemon::{CatalogWatchError, Error as DaemonError};

fn install_lane(local: &Local) {
    let mut owned = local.sources.0.lock().unwrap();
    owned.catalog.seed(&snapshot());
    // A live lane at sequence 5.
    owned.catalog.watch = Some(CatalogWatchWorker::detached(5));
}
fn window(session: bool) -> (Local, mpsc::Receiver<Incoming>) {
    let (local, receiver) = quiet_link_fixture::window(session);
    install_lane(&local);
    (local, receiver)
}
/// The lane's sequence: the same lane while it stays the same number.
fn lane(local: &Local) -> Option<u64> {
    let owned = local.sources.0.lock().unwrap();
    owned.catalog.watch.as_ref().map(CatalogWatchWorker::sequence)
}
fn reading(local: &Local) -> bool {
    local.sources.catalog_busy().unwrap()
}

/// Switching to another app and back keeps Home's lane: no new socket and
/// no re-read of the catalog when the window is in front again. On main the
/// lane was closed when the window left the front and a new one opened, with
/// a full catalog read, each time it came back.
#[test]
fn home_keeps_its_catalog_lane_while_the_window_is_in_the_background() {
    let (mut local, _events) = window(false);
    local.selected_catalog_tick().unwrap();
    assert_eq!(lane(&local), Some(5));
    for _ in 0..3 {
        presence(&mut local, false);
        local.selected_catalog_tick().unwrap();
        assert_eq!(lane(&local), Some(5), "the lane closed in the background");
        presence(&mut local, true);
        local.selected_catalog_tick().unwrap();
        assert_eq!(lane(&local), Some(5), "a new lane opened on return");
        assert!(!reading(&local), "the catalog was read again on return");
    }
}

/// The same for an open session's sidebar.
#[test]
fn a_session_keeps_its_catalog_lane_while_the_window_is_in_the_background() {
    let (mut local, _events) = window(true);
    local.selected_catalog_tick().unwrap();
    assert_eq!(lane(&local), Some(5));
    presence(&mut local, false);
    local.selected_catalog_tick().unwrap();
    assert_eq!(lane(&local), Some(5), "the lane closed in the background");
    presence(&mut local, true);
    local.selected_catalog_tick().unwrap();
    assert_eq!(lane(&local), Some(5), "a new lane opened on return");
    assert!(!reading(&local));
}

/// The open session's lane drops: the sidebar keeps its agent rows as last
/// known and retries the lane with Home's backoff. On main the rows were
/// wiped and the session stopped observing until it was opened again.
#[test]
fn a_session_lane_drop_keeps_the_rows_and_retries() {
    let (mut local, _events) = window(true);
    local.selected_catalog_tick().unwrap();
    {
        let mut owned = local.sources.0.lock().unwrap();
        owned.catalog.watch.take();
        owned.catalog.failure = Some(DaemonError::CatalogWatch(Box::new(
            CatalogWatchError::Closed,
        )));
    }
    local.selected_catalog_tick().unwrap();
    assert!(
        local.workspace_catalog_observing(),
        "the session stopped observing"
    );
    assert!(local.home.active(), "nothing retries the lane");
    // The retry is due: the lane resumes after its cursor.
    local.home.retry_now(Instant::now());
    local.home_recovery_tick().unwrap();
    let owned = local.sources.0.lock().unwrap();
    assert!(owned.catalog.recovering, "the lane was not resumed");
}

/// The Mac woke or the network is back: a waiting retry of Home's lane runs
/// at once and its backoff starts over, as a session stream's does.
#[test]
fn a_wake_retries_home_at_once() {
    let (mut local, _events) = window(false);
    let lost = || DaemonError::CatalogWatch(Box::new(CatalogWatchError::Timeout));
    let held = |local: &Local| local.sources.0.lock().unwrap().catalog.held;
    // Four failed retries in a row: the next waits 4 s.
    local.home_catalog_failed(lost()).unwrap();
    for _ in 0..4 {
        local.home.retry_now(Instant::now());
        local.home_recovery_tick().unwrap();
        assert!(!held(&local));
        local.home_catalog_failed(lost()).unwrap();
    }
    assert!(held(&local));
    assert!(
        (local.home.wait(Instant::now()))
            .is_some_and(|wait| wait > Duration::from_secs(1))
    );
    local.home_recovery_tick().unwrap();
    assert!(held(&local), "retried before its backoff");
    network_watch::simulate_wake();
    local.home_recovery_tick().unwrap();
    assert!(!held(&local), "a wake did not retry at once");
    assert_eq!(local.home.attempt(), Some(1), "the backoff did not start over");
}
