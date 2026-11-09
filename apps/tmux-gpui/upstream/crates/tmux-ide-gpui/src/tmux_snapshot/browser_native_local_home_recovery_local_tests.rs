//! Home's reconnect state machine on a real `Local`, without a daemon.
use super::*;
use herdr_client::tmux_daemon::Error as DaemonError;

fn home_with_a_session() -> (Local, mpsc::Receiver<Incoming>) {
    let (mut local, events) = fixture();
    local.state.surface = Surface::Home;
    local.state.sessions = vec![Choice {
        id: "session-a".into(),
        label: "alpha".into(),
        pane_count: Some(2),
        window_id: None,
        browser_icon: None,
        window_label: None,
    }];
    local.targets.insert(
        "session-a".into(),
        Target {
            scope: ServerScope {
                server_id: format!("tmux-server.{}", "a".repeat(32)),
                generation: uuid::Uuid::new_v4().to_string(),
            },
            live: "live-session.01234567890123456789".into(),
        },
    );
    (local, events)
}
/// The last state the actor published.
fn published(events: &mpsc::Receiver<Incoming>) -> State {
    let mut last = None;
    while let Ok(event) = events.try_recv() {
        if let Incoming::Catalog(state) = event {
            last = Some(*state);
        }
    }
    last.unwrap()
}

#[test]
fn a_dropped_catalog_keeps_the_list_and_reconnects_quietly() {
    let (mut local, events) = home_with_a_session();
    local
        .home_catalog_failed(DaemonError::IdentityChanged)
        .unwrap();
    let state = published(&events);
    assert_eq!(state.home_phase, HomePhase::Live);
    assert_eq!(state.sessions.len(), 1, "the last good list stays");
    assert_eq!(state.status, "Reconnecting…");
    assert_eq!(state.reconnect_attempt, Some(1));
    assert!(!state.home_fault);
    assert!(local.stage.is_none(), "nothing is read before the delay");
}

#[test]
fn a_due_retry_is_a_fresh_catalog_read_only_while_home_is_in_front() {
    let (mut local, events) = home_with_a_session();
    local.home_catalog_failed(DaemonError::OwnerExited).unwrap();
    local.home_recovery_tick().unwrap();
    assert!(local.stage.is_none(), "not yet due");
    local.home.retry_now(Instant::now());
    local.foreground = false;
    local.home_recovery_tick().unwrap();
    assert!(local.stage.is_none(), "paused in the background");
    local.foreground = true;
    local.home_recovery_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Servers)));
    assert!(!local.submitted);
    assert_eq!(published(&events).sessions.len(), 1);
}

#[test]
fn a_successful_read_ends_recovery_and_replaces_the_list() {
    let (mut local, _events) = home_with_a_session();
    local
        .home_catalog_failed(DaemonError::RecordChanged)
        .unwrap();
    local.home_recovered();
    assert!(!local.home.active());
    assert!(
        local.targets.is_empty(),
        "the next catalog rebuilds every target"
    );
}

#[test]
fn a_failure_that_cannot_recover_keeps_the_list_and_says_why() {
    let (mut local, events) = home_with_a_session();
    local
        .home_catalog_failed(DaemonError::Incompatible(3))
        .unwrap();
    let state = published(&events);
    assert!(state.home_fault);
    assert!(state.status.contains("needs an update"));
    assert_eq!(state.sessions.len(), 1);
    assert_eq!(state.reconnect_attempt, None);
    assert!(!local.home.active());
    local.home(1).unwrap();
    assert!(!published(&events).home_fault, "Refresh starts over");
}

#[test]
fn opening_a_session_waits_for_home_to_reconnect() {
    let (mut local, events) = home_with_a_session();
    local
        .home_catalog_failed(DaemonError::IdentityChanged)
        .unwrap();
    local.open(1, "session-a".into(), None).unwrap();
    assert!(local.stage.is_none());
    assert_eq!(local.state.surface, Surface::Home);
    assert_eq!(published(&events).status, "Still reconnecting…");
}

#[test]
fn refresh_ends_a_reconnect_in_progress() {
    let (mut local, _events) = home_with_a_session();
    local
        .home_catalog_failed(DaemonError::IdentityChanged)
        .unwrap();
    local.home(1).unwrap();
    assert!(!local.home.active());
}
