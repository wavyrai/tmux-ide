#![allow(clippy::unwrap_used)]
//! Found by the request-count run on 12 Nov 2026: a session created in the app
//! was opened before the daemon listed its pane, and the window stopped on
//! "Session has no attachable terminal panes" until refreshed.
use super::super::reconnect::tests::{attached, last_catalog};
use super::*;

fn target(local: &Local) -> Target {
    local.active.as_ref().unwrap().target.clone()
}
/// The fixture's session, when no route is open.
fn target_of(local: &Local) -> Target {
    Target {
        scope: ServerScope {
            server_id: "server".into(),
            generation: "generation".into(),
        },
        live: local.state.selected_session.clone().unwrap(),
    }
}
/// The daemon opened the session and listed no pane.
fn opened_empty(local: &mut Local, target: &Target) {
    let stage = Stage::Open {
        target: target.clone(),
        preferred: Some("%2".into()),
    };
    let result = CatalogResult::Opened {
        workspace_name: "fixture".into(),
        panes: Vec::new(),
    };
    local.completed(stage, result).unwrap();
}
/// A session being opened: no stream yet.
fn opening() -> (Local, mpsc::Receiver<Incoming>, Target) {
    let (mut local, events) = attached();
    let target = target(&local);
    local.active = None;
    local.state.status = "Opening terminal".into();
    (local, events, target)
}

#[test]
fn a_session_opened_without_panes_is_opened_again_before_the_window_stops() {
    let (mut local, events, target) = opening();
    let mut waits = Vec::new();
    for _ in 0..5 {
        let before = Instant::now();
        opened_empty(&mut local, &target);
        assert!(local.state.home_phase != HomePhase::Unavailable);
        assert_eq!(local.state.status, "Opening terminal");
        assert!(local.stage.is_none());
        // Not before it is due.
        local.empty_open_tick().unwrap();
        assert!(local.stage.is_none(), "opened again without waiting");
        let wait = local.empty_open_wait().unwrap();
        assert!(wait <= before.elapsed() + Duration::from_millis(1600));
        waits.push((wait.as_millis() + 5) / 100 * 100);
        local.empty_open.due_now();
        local.empty_open_tick().unwrap();
        let Some(Stage::Open {
            target: again,
            preferred,
        }) = &local.stage
        else {
            panic!("the open was not tried again");
        };
        assert_eq!(again.live, target.live);
        assert_eq!(again.scope, target.scope);
        assert_eq!(preferred.as_deref(), Some("%2"));
        local.stage = None;
    }
    assert_eq!(waits, [100, 200, 400, 800, 1600]);
    // Still none after about three seconds: now it is said.
    opened_empty(&mut local, &target);
    let published = last_catalog(&events);
    assert!(published.home_phase == HomePhase::Unavailable);
    assert_eq!(published.status, "Session has no attachable terminal panes");
    assert!(local.empty_open_wait().is_none());
}

#[test]
fn a_session_that_lists_its_pane_on_a_later_try_opens() {
    let (mut local, _events, target) = opening();
    opened_empty(&mut local, &target);
    local.empty_open.due_now();
    local.empty_open_tick().unwrap();
    let stage = local.stage.take().unwrap();
    let result = CatalogResult::Opened {
        workspace_name: "fixture".into(),
        panes: vec!["%2".into()],
    };
    local.completed(stage, result).unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    // The lease is under way: nothing is opened again.
    local.empty_open.due_now();
    local.empty_open_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
}

#[test]
fn leaving_the_session_ends_the_tries() {
    let (mut local, _events, target) = opening();
    opened_empty(&mut local, &target);
    local.home(8).unwrap();
    local.stage = None;
    local.empty_open.due_now();
    local.empty_open_tick().unwrap();
    assert!(local.stage.is_none(), "an abandoned session was opened");
    assert!(local.empty_open_wait().is_none());
}

/// While reconnecting, a session that is listed but has no pane to attach yet
/// (its server owner was just rebuilt) is one more failed try, not a stop.
#[test]
fn a_reconnect_that_finds_no_panes_yet_keeps_reconnecting() {
    let (mut local, _events) = attached();
    let target = target(&local);
    local.reconnect_start().unwrap();
    opened_empty(&mut local, &target);
    assert!(
        local
            .recovery
            .as_ref()
            .is_some_and(reconnect::Recovery::waiting)
    );
    assert_eq!(local.state.status, reconnect::RECONNECTING);
    assert_eq!(local.state.surface, Surface::Workspace);
    assert!(local.empty_open_wait().is_none());
}

fn refused() -> herdr_client::tmux_daemon::Error {
    herdr_client::tmux_daemon::Error::RequestStatus(409)
}

/// Soak, 12 Nov 2026: a pane split by another client re-opened the open
/// session, the daemon refused the open, and the window emptied to "Session
/// changed or is unavailable — refresh to retry" (audit row 10).
#[test]
fn a_session_whose_open_or_lease_fails_is_recovered_not_stopped() {
    for lease in [false, true] {
        let (mut local, events, target) = opening();
        let stage = if lease {
            Stage::Issue {
                target: target.clone(),
                workspace: "fixture".into(),
                panes: vec!["%1".into(), "%2".into()],
                selected: "%2".into(),
            }
        } else {
            Stage::Open {
                target: target.clone(),
                preferred: Some("%2".into()),
            }
        };
        let before = Instant::now();
        local.stage_failed(stage, &refused()).unwrap();
        let recovery = local.recovery.as_ref().unwrap();
        assert!(recovery.waiting(), "nothing tries again");
        assert!(before.elapsed() < Duration::from_millis(200));
        let published = last_catalog(&events);
        assert_eq!(published.surface, Surface::Workspace);
        assert!(published.home_phase != HomePhase::Unavailable);
        assert_eq!(published.status, reconnect::RECONNECTING);
        assert_eq!(published.selected_session.as_deref(), Some("$1"));
        // The first try is at once and reads the catalog: the session, its
        // panes and the pane to select are looked up again.
        local.reconnect_tick().unwrap();
        assert!(matches!(local.stage, Some(Stage::Servers)), "{lease}");
    }
}

#[test]
fn a_failure_with_nothing_being_opened_still_stops_home_and_keeps_looking() {
    let (mut local, events, _target) = opening();
    local.state.surface = Surface::Home;
    let stage = Stage::Open {
        target: target_of(&local),
        preferred: None,
    };
    local.stage_failed(stage, &refused()).unwrap();
    assert!(local.recovery.is_none());
    let published = last_catalog(&events);
    assert!(published.home_phase == HomePhase::Unavailable);
    assert_eq!(
        published.status,
        "Session changed or is unavailable — refresh to retry"
    );
    assert!(local.home.quiet.due_now(), "Home does not keep looking");
}

/// With a recovery under way a failed request is one more failed try.
#[test]
fn a_failure_during_a_recovery_backs_off_and_tries_again() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    local.reconnect_tick().unwrap();
    let stage = local.stage.take().unwrap();
    // The daemon is gone: the same recovery waits out its backoff. It is not
    // replaced by a new one that would try again at once.
    let gone = herdr_client::tmux_daemon::Error::OwnerExited;
    local.stage_failed(stage, &gone).unwrap();
    assert!(
        local
            .recovery
            .as_ref()
            .is_some_and(reconnect::Recovery::waiting)
    );
    assert_eq!(local.recovery.as_ref().unwrap().attempt(), 1);
    assert_eq!(local.state.surface, Surface::Workspace);
    local.reconnect_tick().unwrap();
    assert!(local.stage.is_none(), "the failed try did not back off");
}

/// Long soak, 12 Nov 2026: with the daemon answering 503 for a tmux server
/// that had stopped answering, a refresh ended on "refresh to retry". Home
/// now says what is wrong, and goes on looking by itself as before.
#[test]
fn a_daemon_whose_tmux_server_does_not_answer_is_named_and_retried() {
    let (mut local, events, _target) = opening();
    local.state.surface = Surface::Home;
    let unanswered = herdr_client::tmux_daemon::Error::RequestStatus(503);
    local.stage_failed(Stage::Servers, &unanswered).unwrap();
    let published = last_catalog(&events);
    assert_eq!(
        published.status,
        "The tmux server is not answering. Tmux IDE keeps trying."
    );
    assert!(local.home.quiet.due_now(), "Home does not keep looking");
    // Any other refusal keeps the general words.
    let (mut local, events, _target) = opening();
    local.state.surface = Surface::Home;
    let other = herdr_client::tmux_daemon::Error::RequestStatus(500);
    local.stage_failed(Stage::Servers, &other).unwrap();
    assert_eq!(
        last_catalog(&events).status,
        "Session changed or is unavailable — refresh to retry"
    );
}

/// Review of b7341466, B1: with a saved SSH machine selected nothing reloads
/// Home by itself, so Home must not say it keeps trying.
#[test]
fn home_says_it_keeps_trying_only_where_it_does() {
    let (mut local, events, _target) = opening();
    local.state.surface = Surface::Home;
    local.selected_profile = Some(herdr_client::tmux_daemon::SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Build".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: None,
        enabled: true,
    });
    let unanswered = herdr_client::tmux_daemon::Error::RequestStatus(503);
    local.stage_failed(Stage::Servers, &unanswered).unwrap();
    let status = last_catalog(&events).status;
    assert!(
        local.home.quiet.wait(Instant::now()).is_some() || !status.contains("keeps trying"),
        "status {status:?} while nothing retries"
    );
    assert_eq!(
        status,
        "Session changed or is unavailable — refresh to retry"
    );
}

/// N1: the daemon answers 503 for more than a silent tmux server. Only a
/// failed catalog read gets the tmux sentence.
#[test]
fn only_a_catalog_read_that_got_503_blames_the_tmux_server() {
    let (mut local, events, target) = opening();
    local.state.surface = Surface::Home;
    let unanswered = herdr_client::tmux_daemon::Error::RequestStatus(503);
    let stage = Stage::Open {
        target,
        preferred: None,
    };
    local.stage_failed(stage, &unanswered).unwrap();
    assert_eq!(
        last_catalog(&events).status,
        "Session changed or is unavailable — refresh to retry"
    );
}

/// N2: while Home reloads quietly, its sentence follows why the latest try
/// failed. The same reason again publishes nothing.
#[test]
fn the_stopped_sentence_follows_the_latest_failed_try() {
    let (mut local, events, _target) = opening();
    local.state.surface = Surface::Home;
    let gone = herdr_client::tmux_daemon::Error::OwnerExited;
    let unanswered = herdr_client::tmux_daemon::Error::RequestStatus(503);
    local.stage_failed(Stage::Servers, &gone).unwrap();
    assert_eq!(
        last_catalog(&events).status,
        "Session changed or is unavailable — refresh to retry"
    );
    local.quiet_failed(&gone).unwrap();
    assert!(
        events.try_recv().is_err(),
        "the same failure repainted Home"
    );
    local.quiet_failed(&unanswered).unwrap();
    assert_eq!(
        last_catalog(&events).status,
        "The tmux server is not answering. Tmux IDE keeps trying."
    );
    local.quiet_failed(&unanswered).unwrap();
    assert!(
        events.try_recv().is_err(),
        "the same failure repainted Home"
    );
    local.quiet_failed(&gone).unwrap();
    assert_eq!(
        last_catalog(&events).status,
        "Session changed or is unavailable — refresh to retry"
    );
    // A stop with other words (only the user can clear it) is left alone.
    local.unavailable(reconnect::UPDATE_APP).unwrap();
    while events.try_recv().is_ok() {}
    local.quiet_failed(&unanswered).unwrap();
    assert!(events.try_recv().is_err());
    assert_eq!(local.state.status, reconnect::UPDATE_APP);
}
