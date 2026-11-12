//! Owner, 12 Nov 2026: a dropped stream comes back by itself, in an active or
//! inactive window, for as long as the window is open. The daemon had closed
//! streams with 1001 "daemon-shutdown" several times in two minutes while it
//! stayed up on the same port, after it rebuilt a tmux server owner.
use super::*;
use herdr_client::tmux_daemon::{CatalogIdentity, FleetCatalog, ServerRegistration};

fn delays(local: &mut Local, tries: usize) -> Vec<u128> {
    let before = Instant::now();
    local.reconnect_start().unwrap();
    let mut delays = vec![delay(local, before)];
    for _ in 1..tries {
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.reconnect_tick().unwrap();
        let before = Instant::now();
        local.reconnect_retry(Failure::Unreachable).unwrap();
        delays.push(delay(local, before));
    }
    delays
}

#[test]
fn the_first_try_is_at_once_and_a_local_daemon_is_retried_every_five_seconds_at_most() {
    let (mut local, _events) = attached();
    assert_eq!(
        delays(&mut local, 8),
        [0, 250, 500, 1000, 2000, 4000, 5000, 5000]
    );
}

#[test]
fn over_ssh_the_backoff_cap_stays_thirty_seconds() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    local.recovery.as_mut().unwrap().local_record = None;
    for _ in 0..12 {
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.reconnect_tick().unwrap();
        local.reconnect_retry(Failure::Unreachable).unwrap();
    }
    let before = Instant::now();
    local.reconnect_retry(Failure::Unreachable).unwrap();
    assert_eq!(delay(&local, before), 30000);
}

/// The owner's window was not the key window: 0.1.16 waited for a click.
#[test]
fn an_inactive_window_reconnects_without_being_activated() {
    let (mut local, _events) = attached();
    local.foreground = false;
    local.reconnect_start().unwrap();
    local.reconnect_tick().unwrap();
    assert!(
        matches!(local.stage, Some(Stage::Issue { .. })),
        "no lease was requested for the inactive window"
    );
    assert!(local.lease_allowed());
    // Losing focus during the try does not cancel it either.
    local.submitted = true;
    local
        .command(Command::Presence {
            active: false,
            revision: 1,
        })
        .unwrap();
    assert!(local.submitted);
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
}

#[test]
fn an_inactive_window_still_gets_no_lease_for_a_new_open() {
    let (mut local, _events) = attached();
    local.foreground = false;
    assert!(!local.lease_allowed());
}

/// An inactive window never gets input authority, so its stream is back once
/// frames flow. The visit is still recorded only by an active window.
#[test]
fn a_live_stream_in_an_inactive_window_ends_the_reconnecting_badge() {
    let (mut local, events) = attached();
    local.catalog_identity = Some(CatalogIdentity {
        instance_id: "instance".into(),
        environment_id: Some("environment".into()),
    });
    local.foreground = false;
    local.reconnect_start().unwrap();
    let ready = |input_ready| Command::NativeTerminalReady {
        version: 1,
        id: "old-route".into(),
        request: 7,
        pane: "%2".into(),
        live_session_id: "$1".into(),
        generation: "generation".into(),
        presence_revision: 0,
        input_ready,
        coherent: true,
    };
    let route = |local: &mut Local| {
        let target = local.recovery.as_ref().unwrap().target.clone();
        local.active = Some(Route {
            id: "old-route".into(),
            request: 7,
            target,
            workspace: "fixture".into(),
        });
    };
    route(&mut local);
    local.command(ready(false)).unwrap();
    assert!(local.recovery.is_none());
    let published = last_catalog(&events);
    assert_eq!(published.reconnect_attempt, None);
    assert_eq!(published.status, "Connected");
    assert!(local.preferences.visits.active_key().is_none());
    // An active window still waits for input.
    local.foreground = true;
    local.reconnect_start().unwrap();
    route(&mut local);
    local.command(ready(false)).unwrap();
    assert!(local.recovery.is_some());
    local.command(ready(true)).unwrap();
    assert!(local.recovery.is_none());
}

#[test]
fn no_number_of_failures_ends_recovery() {
    for failure in [Failure::Other, Failure::Identity, Failure::Away] {
        let (mut local, _events) = attached();
        local.reconnect_start().unwrap();
        for _ in 0..300 {
            local.reconnect_retry(failure).unwrap();
        }
        assert!(
            local.recovery.as_ref().is_some_and(Recovery::waiting),
            "{failure:?}"
        );
        assert_eq!(local.state.status, RECONNECTING);
        assert_eq!(local.state.surface, Surface::Workspace);
    }
}

/// daemon.json may name a new port or token after any failure, not only a
/// refused connection on the second try.
#[test]
fn every_failed_try_reads_the_daemon_record_again() {
    for failure in [Failure::Unreachable, Failure::Other, Failure::Identity] {
        let (mut local, _events) = attached();
        local.reconnect_start().unwrap();
        assert!(!local.recovery.as_ref().unwrap().rediscover_owner);
        local.reconnect_tick().unwrap();
        local.reconnect_retry(failure).unwrap();
        assert!(
            local.recovery.as_ref().unwrap().rediscover_owner,
            "{failure:?}"
        );
    }
}

fn offline(server: &str) -> ServerRegistration {
    ServerRegistration::Offline {
        label: "default".into(),
        server_id: server.into(),
    }
}
fn online(server: &str, generation: &str) -> ServerRegistration {
    ServerRegistration::Online {
        label: "default".into(),
        scope: ServerScope {
            server_id: server.into(),
            generation: generation.into(),
        },
    }
}
/// Recovery in rediscovery, as after the daemon refused the old generation.
fn rediscovering() -> (Local, mpsc::Receiver<Incoming>) {
    let (mut local, events) = attached();
    local.state.sessions = vec![Choice {
        id: "$1".into(),
        label: "work".into(),
        pane_count: Some(2),
        window_id: None,
        browser_icon: None,
        display_name_source: None,
        window_label: None,
    }];
    local.reconnect_start().unwrap();
    local.reconnect_tick().unwrap();
    local.reconnect_retry(Failure::Other).unwrap();
    assert!(local.recovery.as_ref().unwrap().rebind.is_none());
    (local, events)
}

/// The owner's case: the daemon retired the server owner after one slow probe,
/// so the next catalog listed the server as offline. 0.1.16 emptied the window
/// ("Previous session identity changed or disappeared") and stopped.
#[test]
fn a_catalog_that_lists_the_server_offline_keeps_reconnecting() {
    for servers in [vec![offline("server")], vec![online("other", "g")], vec![]] {
        let (mut local, events) = rediscovering();
        local.catalog_servers(servers);
        assert!(local.reconnect_catalog().unwrap());
        assert!(local.recovery.as_ref().is_some_and(Recovery::waiting));
        let published = last_catalog(&events);
        assert_eq!(published.surface, Surface::Workspace);
        assert!(published.home_phase != HomePhase::Unavailable);
        assert_eq!(published.selected_session.as_deref(), Some("$1"));
        assert_eq!(published.status, RECONNECTING);
        assert!(published.reconnect_attempt.is_some());
    }
}

/// The same through the catalog's own entry point: with no server online it
/// used to leave the session for the "create a session" Home.
#[test]
fn a_catalog_with_no_online_server_keeps_reconnecting() {
    let (mut local, _events) = rediscovering();
    local.stage = None;
    local
        .receive_catalog(
            FleetCatalog {
                identity: CatalogIdentity {
                    instance_id: "instance".into(),
                    environment_id: Some("environment".into()),
                },
                servers: vec![offline("server")],
                sessions: Vec::new(),
            },
            true,
        )
        .unwrap();
    assert!(local.recovery.as_ref().is_some_and(Recovery::waiting));
    assert!(local.stage.is_none(), "left the session for another stage");
    assert_eq!(local.state.surface, Surface::Workspace);
    assert_eq!(local.state.status, RECONNECTING);
}

/// The server answered and no longer has the session: it ended. Home is
/// loaded again with a notice that names it, not an empty window.
#[test]
fn a_session_missing_from_its_online_server_ends_on_home_with_a_notice() {
    for generation in ["generation", "generation-after-rebuild"] {
        let (mut local, events) = rediscovering();
        local.catalog_servers(vec![online("server", generation)]);
        assert!(local.reconnect_catalog().unwrap());
        assert!(local.recovery.is_none());
        assert!(matches!(local.stage, Some(Stage::Servers)));
        let published = last_catalog(&events);
        assert_eq!(published.surface, Surface::Home);
        assert!(published.home_phase != HomePhase::Unavailable);
        assert_eq!(published.reconnect_attempt, None);
        assert_eq!(
            published.home_notice.as_deref(),
            Some("“work” ended: its tmux session is no longer running.")
        );
    }
}

/// Another install's record cannot vouch for a server by id alone.
#[test]
fn an_unknown_daemon_listing_the_server_online_under_another_generation_is_not_trusted() {
    let (mut local, _events) = rediscovering();
    local.recovery.as_mut().unwrap().local_record =
        Some(PathBuf::from("/nonexistent-reconnect-test/another.json"));
    local.catalog_servers(vec![online("server", "another-generation")]);
    assert!(local.reconnect_catalog().unwrap());
    assert!(local.recovery.is_none());
    assert_eq!(
        local.state.status,
        "Previous session identity changed or disappeared — select a session"
    );
}

/// A stream that was ready for a while starts over; one that drops again
/// right after its recovery continues that backoff.
#[test]
fn a_flapping_stream_continues_the_backoff_and_a_settled_one_starts_over() {
    let (mut local, _events) = attached();
    let target = local.active.as_ref().unwrap().target.clone();
    let recover = |local: &mut Local, tries: u32| {
        local.reconnect_start().unwrap();
        local.recovery.as_mut().unwrap().attempts = tries;
        local.active = Some(Route {
            id: "old-route".into(),
            request: 7,
            target: target.clone(),
            workspace: "fixture".into(),
        });
        local
            .command(Command::NativeTerminalReady {
                version: 1,
                id: "old-route".into(),
                request: 7,
                pane: "%2".into(),
                live_session_id: "$1".into(),
                generation: "generation".into(),
                presence_revision: 0,
                input_ready: true,
                coherent: true,
            })
            .unwrap();
        assert!(local.recovery.is_none());
    };
    recover(&mut local, 3);
    let before = Instant::now();
    local.reconnect_start().unwrap();
    assert_eq!(delay(&local, before), 1000, "a flap restarted the backoff");
    recover(&mut local, 3);
    local.flap.age(Duration::from_secs(6));
    let before = Instant::now();
    local.reconnect_start().unwrap();
    assert_eq!(
        delay(&local, before),
        0,
        "a settled stream kept the backoff"
    );
}

/// A drop during a pane action or a session creation still reconnects. The
/// action is cancelled and never replayed; a creation keeps its uncertain id.
#[test]
fn a_drop_during_an_action_reconnects_without_replaying_it() {
    let (mut local, _events) = attached();
    let operation_id = uuid::Uuid::new_v4();
    local.stage = Some(Stage::Create {
        scope: local.active.as_ref().unwrap().target.scope.clone(),
        operation_id,
        name: "never replay".into(),
    });
    local.submitted = true;
    local.reconnect_start().unwrap();
    assert!(local.recovery.is_some());
    assert!(local.stage.is_none());
    assert_eq!(local.uncertain_create, Some(operation_id));
    assert_eq!(local.state.status, RECONNECTING);
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
}

/// A Home that stopped on a failed load: nothing open, nothing recovering.
fn stopped_home() -> (Local, mpsc::Receiver<Incoming>) {
    let (mut local, events) = fixture();
    local.active = None;
    local.state.selected_session = None;
    local.state.selected_pane = None;
    local
        .unavailable_retrying("Session changed or is unavailable — refresh to retry")
        .unwrap();
    (local, events)
}

/// The daemon was not running when the app started, or launchd is bringing it
/// back: 0.1.16 showed "refresh to retry" until someone did.
#[test]
fn a_home_that_failed_to_load_keeps_looking_for_the_daemon_without_repainting() {
    let (mut local, events) = stopped_home();
    assert_eq!(
        last_catalog(&events).status,
        "Session changed or is unavailable — refresh to retry"
    );
    let mut waits = Vec::new();
    for _ in 0..5 {
        let wait = local.home.quiet.wait(Instant::now()).unwrap().as_millis();
        // Rounded to the half second so a slow runner cannot change it.
        waits.push((wait + 250) / 500 * 500);
        // Not before it is due.
        local.quiet_tick().unwrap();
        assert!(local.stage.is_none());
        assert!(local.home.quiet.due_now());
        local.quiet_tick().unwrap();
        assert!(matches!(local.stage, Some(Stage::Servers)));
        assert!(local.home.quiet.probing());
        // The load failed again: nothing is published, the next one is scheduled.
        local.stage = None;
        local.quiet_failed();
        assert!(events.try_recv().is_err(), "a quiet retry repainted Home");
    }
    assert_eq!(waits, [1000, 2000, 4000, 5000, 5000]);
    // The daemon answered: Home starts over as after Refresh.
    assert!(local.home.quiet.due_now());
    local.quiet_tick().unwrap();
    local.home_recovered();
    assert!(local.state.home_phase == HomePhase::Loading);
    assert!(local.home.quiet.wait(Instant::now()).is_none());
}

#[test]
fn only_a_failed_load_of_a_local_daemon_arms_the_quiet_search() {
    // A stop only the user can clear.
    let (mut local, _events) = stopped_home();
    local.unavailable(UPDATE_APP).unwrap();
    assert!(local.home.quiet.wait(Instant::now()).is_none());
    // A saved SSH machine.
    let (mut local, _events) = fixture();
    local.active = None;
    local.selected_profile = Some(herdr_client::tmux_daemon::SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Build".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: None,
        enabled: true,
    });
    local
        .unavailable_retrying("No online tmux servers")
        .unwrap();
    assert!(local.home.quiet.wait(Instant::now()).is_none());
    // Navigation ends the search.
    let (mut local, _events) = stopped_home();
    local.home(8).unwrap();
    assert!(local.home.quiet.wait(Instant::now()).is_none());
    // A window that is no longer stopped does not probe.
    let (mut local, _events) = stopped_home();
    local.state.home_phase = HomePhase::Live;
    assert!(local.home.quiet.due_now());
    local.quiet_tick().unwrap();
    assert!(local.stage.is_none());
    assert!(local.home.quiet.wait(Instant::now()).is_none());
}

/// A restarted daemon writes a new record (a new port and token). The next
/// try then does not wait out its backoff: launchd bringing the daemon back
/// reconnects within the 50 ms tick, not up to five seconds later.
#[test]
fn a_rewritten_daemon_record_is_tried_at_once() {
    let dir = std::env::temp_dir().join(format!("tmux-ide-record-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let record = dir.join("daemon.json");
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    local.recovery.as_mut().unwrap().local_record = Some(record.clone());
    // The first try, with no record there (the daemon is gone).
    local.reconnect_tick().unwrap();
    local.reconnect_retry(Failure::Unreachable).unwrap();
    for _ in 0..6 {
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.reconnect_tick().unwrap();
        local.reconnect_retry(Failure::Unreachable).unwrap();
    }
    let tries = local.recovery.as_ref().unwrap().attempt();
    let due = local.recovery.as_ref().unwrap().due.unwrap();
    assert!(due > Instant::now() + Duration::from_secs(4));
    // Nothing changed: the backoff stands.
    local.reconnect_tick().unwrap();
    assert!(local.stage.is_none());
    // The daemon is back and wrote its record.
    std::fs::write(&record, b"{\"port\":1}").unwrap();
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    assert_eq!(local.recovery.as_ref().unwrap().attempt(), tries + 1);
    // The same record again is not a reason to hurry.
    local.reconnect_retry(Failure::Unreachable).unwrap();
    local.reconnect_tick().unwrap();
    assert!(local.stage.is_none());
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The record that was there when the stream dropped is not a rewrite: a
/// flapping stream keeps its backoff.
#[test]
fn a_record_that_did_not_change_does_not_hurry_a_flapping_stream() {
    let dir = std::env::temp_dir().join(format!("tmux-ide-record-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let record = dir.join("daemon.json");
    std::fs::write(&record, b"{\"port\":1}").unwrap();
    let (mut local, _events) = attached();
    local.sources = NativeOwner::new(CatalogSource::Local(record.clone()));
    local.flap.recovered(4);
    local.reconnect_start().unwrap();
    assert_eq!(
        local.recovery.as_ref().unwrap().local_record,
        Some(record.clone())
    );
    local.reconnect_tick().unwrap();
    assert!(local.stage.is_none(), "tried before the backoff was over");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Coming back to the window is a reason to try now: over SSH the backoff may
/// be thirty seconds.
#[test]
fn activating_the_window_tries_at_once() {
    let (mut local, _events) = attached();
    local.foreground = false;
    local.reconnect_start().unwrap();
    local.recovery.as_mut().unwrap().due = Some(Instant::now() + Duration::from_secs(30));
    // Still inactive: the backoff stands.
    local
        .command(Command::Presence {
            active: false,
            revision: 1,
        })
        .unwrap();
    assert!(local.recovery.as_ref().unwrap().due.unwrap() > Instant::now());
    local
        .command(Command::Presence {
            active: true,
            revision: 2,
        })
        .unwrap();
    assert!(local.recovery.as_ref().unwrap().due.unwrap() <= Instant::now());
}

/// The minute an away server gets counts catalogs in a row. A daemon that
/// could not be reached in between said nothing about the server.
#[test]
fn the_away_minute_starts_over_after_any_other_failure() {
    let (mut local, _events) = rediscovering();
    local.catalog_servers(vec![offline("server")]);
    local.reconnect_catalog().unwrap();
    assert!(local.recovery.as_ref().unwrap().away_since.is_some());
    local.reconnect_retry(Failure::Away).unwrap();
    assert!(local.recovery.as_ref().unwrap().away_since.is_some());
    local.reconnect_retry(Failure::Unreachable).unwrap();
    assert!(local.recovery.as_ref().unwrap().away_since.is_none());
}
