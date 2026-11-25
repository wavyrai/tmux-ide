#![allow(clippy::unwrap_used)]
//! Card #876, review round 1: an open session's catalog lane recovers on
//! its own, without Home's recovery (items 1 and 3), and the agent rows
//! take each machine's push from its own lane (item 2).
use super::quiet_link_fixture::{self, snapshot, window};
use super::*;
use crate::tmux_snapshot::connection::network_watch;
use herdr_client::tmux_daemon::{
    CatalogWatchError, CatalogWatchWorker, Error as DaemonError, FleetRegistry, SavedMachine,
    SavedMachineRegistry,
};
use std::sync::{Arc, Mutex};

/// A live lane on the selected daemon, pushing fleet changes or not.
fn lane(push: bool) -> CatalogWatchWorker {
    let lane = CatalogWatchWorker::detached(5);
    lane.push_detached(push);
    lane
}
fn session() -> (Local, mpsc::Receiver<Incoming>) {
    let (local, events) = window(true);
    local.sources.install_test_lane(&snapshot(), lane(true));
    (local, events)
}
fn lost() -> DaemonError {
    DaemonError::CatalogWatch(Box::new(CatalogWatchError::Timeout))
}
/// The session's lane drops (same daemon) and the drop is taken.
fn drop_lane(local: &mut Local, error: DaemonError) {
    local.selected_catalog_tick().unwrap();
    local.sources.fail_test_lane(error);
    local.selected_catalog_tick().unwrap();
}

/// Item 1: while the open session's lane recovers, opening another session
/// is not refused. At 32fe3b22f the session lane used Home's recovery, and
/// `home_open_blocked` refused the open with "Still reconnecting…".
#[test]
fn another_session_opens_while_the_session_lane_recovers() {
    let (mut local, _events) = session();
    drop_lane(&mut local, lost());
    assert!(local.sources.test_held(), "the lane did not drop");
    let mut other = quiet_link_fixture::target();
    other.live = "$2".into();
    local.targets.insert("other".into(), other);
    local
        .command(Command::Session {
            request: 8,
            id: "other".into(),
        })
        .unwrap();
    assert_ne!(local.state.status, home_recovery::STILL_RECONNECTING);
    assert_eq!(local.state.request, 8, "the open was refused");
}

/// Item 3: the lane comes back; the session's recovery ends, its status line
/// is left alone, and the agent rows are read again instead of staying
/// paused as last known.
#[test]
fn a_resumed_session_lane_reads_the_rows_again_and_says_nothing() {
    let (mut local, _events) = session();
    local.state.status = "Connected".into();
    drop_lane(&mut local, lost());
    assert!(
        local.home_recovery_wait().is_some(),
        "the actor would not wake for the retry"
    );
    network_watch::simulate_wake();
    local.home_recovery_tick().unwrap();
    assert!(
        !local.sources.test_held(),
        "the retry did not resume the lane"
    );
    assert_eq!(
        local.state.status, "Connected",
        "a session's status line was changed"
    );
    // The resumed lane is live again: the resume starts the re-read.
    local.sources.install_test_lane(&snapshot(), lane(true));
    local.selected_catalog_tick().unwrap();
    assert!(
        local.agents.cycle && !local.agents.stale,
        "the rows stayed paused after the lane came back"
    );
    assert!(
        local.home_recovery_wait().is_none(),
        "the recovery did not end"
    );
}

/// Item 3: a lane that cannot resume (nothing kept to resume) stops
/// observing, as before the card.
#[test]
fn a_session_lane_that_cannot_resume_stops_observing() {
    let (mut local, _events) = session();
    drop_lane(&mut local, lost());
    local.sources.reset_catalog().unwrap();
    network_watch::simulate_wake();
    local.home_recovery_tick().unwrap();
    assert!(!local.workspace_catalog_observing());
}

/// Item 3: another daemon behind the session, or a failure only the user can
/// fix, stops observing at once; only a dropped link to the same daemon is
/// retried.
#[test]
fn only_a_dropped_link_to_the_same_daemon_is_retried() {
    let refused = tungstenite::Error::Http(Box::new(
        tungstenite::http::Response::builder()
            .status(401)
            .body(None)
            .unwrap(),
    ));
    for (name, error) in [
        (
            "another daemon",
            DaemonError::CatalogWatch(Box::new(CatalogWatchError::Owner(
                DaemonError::IdentityChanged,
            ))),
        ),
        (
            "credentials refused",
            DaemonError::CatalogWatch(Box::new(CatalogWatchError::Socket(Box::new(refused)))),
        ),
    ] {
        let (mut local, _events) = session();
        drop_lane(&mut local, error);
        assert!(!local.workspace_catalog_observing(), "{name} was retried");
        assert!(local.home_recovery_wait().is_none(), "{name}");
    }
}

fn saved_machine() -> SavedMachine {
    SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Saved".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: None,
        enabled: true,
    }
}
/// Home with the selected daemon's lane and one saved machine's lane, and
/// agent rows on both machines. Returns the saved machine's id.
type Fleet = (
    Local,
    String,
    Arc<Mutex<FleetRegistry>>,
    mpsc::Receiver<Incoming>,
);
fn fleet(selected_push: bool, saved_push: bool) -> Fleet {
    let (mut local, events) = window(false);
    local
        .sources
        .install_test_lane(&snapshot(), lane(selected_push));
    let machine = saved_machine();
    let mut registry =
        FleetRegistry::new(PathBuf::from("/nonexistent-session-lane-test/daemon.json"));
    registry
        .reconcile(
            SavedMachineRegistry {
                version: 1,
                machines: vec![machine.clone()],
            },
            "local",
        )
        .unwrap();
    let incarnation = registry
        .routes()
        .find(|(id, _, _)| *id == machine.id)
        .unwrap()
        .2;
    registry.set_watch(&machine.id, lane(saved_push));
    let handle = Arc::new(Mutex::new(registry));
    local
        .background_fleet
        .install_test_route(handle.clone(), &machine.id, incarnation);
    let mut remote = tests::context();
    remote.machine = machine.id.clone();
    remote.key = "saved-key".into();
    remote.incarnation = Some(incarnation);
    local
        .agents
        .configure(vec![tests::context(), remote], 2, false, 0, Instant::now());
    (local, machine.id, handle, events)
}
/// A read cycle ends; what is due next.
fn after_cycle(local: &mut Local) -> Option<Instant> {
    local.agents.cycle = true;
    local.agents.due = None;
    local.agents.poll(false, Instant::now());
    local.agents.due
}

/// Item 2: both machines push: no timer.
#[test]
fn rows_on_two_pushing_machines_need_no_timer() {
    let (mut local, _saved, handle, _events) = fleet(true, true);
    local.selected_catalog_tick().unwrap();
    assert!(
        after_cycle(&mut local).is_none(),
        "a timer runs although both push"
    );
    handle.lock().unwrap().invalidate().unwrap();
}

/// Item 2: a saved machine's notice makes a read due at once.
#[test]
fn a_saved_machine_notice_reads_the_rows() {
    let (mut local, saved, handle, _events) = fleet(true, true);
    local.selected_catalog_tick().unwrap();
    assert!(after_cycle(&mut local).is_none());
    handle
        .lock()
        .unwrap()
        .watch(&saved)
        .unwrap()
        .report_detached(false);
    handle.lock().unwrap().poll().unwrap();
    local.selected_catalog_tick().unwrap();
    assert!(
        local.agents.due.is_some_and(|due| due <= Instant::now()),
        "the saved machine's notice did not reach the rows"
    );
    handle.lock().unwrap().invalidate().unwrap();
}

/// Item 2: a machine whose daemon does not push keeps the 5 s re-read,
/// whichever machine it is.
#[test]
fn a_machine_without_push_keeps_the_timer() {
    for (selected, saved) in [(true, false), (false, true)] {
        let (mut local, _saved, handle, _events) = fleet(selected, saved);
        local.selected_catalog_tick().unwrap();
        assert!(
            after_cycle(&mut local).is_some_and(|due| due > Instant::now()),
            "selected push {selected}, saved push {saved}: the timer stopped"
        );
        handle.lock().unwrap().invalidate().unwrap();
    }
}

/// Item 2: the selected machine's push comes from its own lane. When the
/// selected machine is a saved one and its lane does not push, the same
/// machine's background lane does not stand in for it.
#[test]
fn the_selected_machine_pushes_only_through_its_own_lane() {
    let (mut local, saved, handle, _events) = fleet(false, true);
    local.machine_id = saved.clone();
    let mut context = tests::context();
    context.machine = saved;
    local
        .agents
        .configure(vec![context], 1, false, 0, Instant::now());
    local.selected_catalog_tick().unwrap();
    assert!(
        after_cycle(&mut local).is_some(),
        "the background lane stood in for the selected one"
    );
    handle.lock().unwrap().invalidate().unwrap();
}
