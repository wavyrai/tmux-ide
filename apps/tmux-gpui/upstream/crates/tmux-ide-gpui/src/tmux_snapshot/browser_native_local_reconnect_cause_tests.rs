//! PM, 12 Nov 2026: why a stream ended picks the first step of its recovery.
//! Every cause reconnects; a reason this app does not know is a plain close.
use super::always::{online, rediscovering};
use super::*;

fn interrupted(cause: Cause) -> Command {
    Command::NativeTerminalInterrupted {
        version: 1,
        id: "old-route".into(),
        request: 7,
        pane: "%2".into(),
        live_session_id: "$1".into(),
        generation: "generation".into(),
        presence_revision: 0,
        cause,
    }
}
/// The route a lease of the recovery opened: a stream that can drop again.
fn leased(local: &mut Local) {
    let target = local.recovery.as_ref().unwrap().target.clone();
    local.active = Some(Route {
        id: "old-route".into(),
        request: 7,
        target,
        workspace: "fixture".into(),
        window: None,
        notice: None,
        window_panes: Vec::new(),
    });
}
/// The stream came back and was ready, after `tries` tries.
fn recovered(local: &mut Local, tries: u32) {
    local.recovery.as_mut().unwrap().attempts = tries;
    leased(local);
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
}

/// The owner's case: three closes by a daemon that stayed up, 19 s and 25 s
/// apart, and then more. 0.1.16 waited longer after each one.
#[test]
fn a_close_sent_by_the_daemon_is_retried_at_once_from_the_start_of_the_backoff() {
    for cause in [
        Cause::Closed,
        Cause::ServerRetired,
        Cause::DaemonRestarting,
        Cause::PanesClosed,
    ] {
        let (mut local, _events) = attached();
        local.reconnect_start().unwrap();
        recovered(&mut local, 5);
        // 1 s after a recovery that took five tries: a flap by the old rule.
        let before = Instant::now();
        local.command(interrupted(cause)).unwrap();
        assert_eq!(delay(&local, before), 0, "{cause:?} waited");
        assert_eq!(local.recovery.as_ref().unwrap().attempts, 0, "{cause:?}");
    }
}

#[test]
fn a_stream_lost_without_a_close_frame_still_continues_a_flapping_backoff() {
    for cause in [Cause::Lost, Cause::Silent, Cause::Identity] {
        let (mut local, _events) = attached();
        local.reconnect_start().unwrap();
        recovered(&mut local, 3);
        let before = Instant::now();
        local.command(interrupted(cause)).unwrap();
        assert_eq!(delay(&local, before), 1000, "{cause:?}");
    }
}

/// A close during a recovery (the re-issued stream was closed before it was
/// ready) starts that recovery's backoff over too.
#[test]
fn a_close_sent_by_the_daemon_during_a_recovery_starts_its_backoff_over() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    local.recovery.as_mut().unwrap().attempts = 6;
    leased(&mut local);
    let before = Instant::now();
    local.command(interrupted(Cause::Closed)).unwrap();
    assert_eq!(delay(&local, before), 0);
    // Without a close frame the recovery goes on where it was.
    local.recovery.as_mut().unwrap().attempts = 6;
    leased(&mut local);
    let before = Instant::now();
    local.command(interrupted(Cause::Lost)).unwrap();
    assert_eq!(delay(&local, before), 5000);
}

/// A daemon that closes every stream as soon as it is ready must not be
/// leased in a tight loop: four fresh starts in ten seconds, then the backoff.
#[test]
fn a_daemon_that_keeps_closing_gets_the_backoff_after_four_fresh_starts() {
    let (mut local, _events) = attached();
    let mut waits = Vec::new();
    local.reconnect_start().unwrap();
    for _ in 0..6 {
        recovered(&mut local, 4);
        let before = Instant::now();
        local.command(interrupted(Cause::Closed)).unwrap();
        waits.push(delay(&local, before));
    }
    assert_eq!(waits, [0, 0, 0, 0, 2000, 2000]);
    // Ten quiet seconds later the next close is fresh again.
    local.flap.age(Duration::from_secs(11));
    recovered(&mut local, 4);
    let before = Instant::now();
    local.command(interrupted(Cause::Closed)).unwrap();
    assert_eq!(delay(&local, before), 0);
}

/// "tmux-server-retired" and "daemon-restarting": the old generation is gone,
/// so no lease is asked for it; the catalog is read at once.
#[test]
fn a_retired_server_or_restarting_daemon_reads_the_catalog_instead_of_the_old_lease() {
    for cause in [Cause::ServerRetired, Cause::DaemonRestarting] {
        let (mut local, _events) = attached();
        local.command(interrupted(cause)).unwrap();
        local.reconnect_tick().unwrap();
        assert!(
            matches!(local.stage, Some(Stage::Servers)),
            "{cause:?} asked for a lease of the retired generation"
        );
        assert_eq!(local.state.surface, Surface::Workspace);
        assert_eq!(local.state.status, RECONNECTING);
    }
}

/// A reason the app does not know, and what a 2.9.22 daemon sends for every
/// close (1001 "daemon-shutdown" while it stays up): one lease for the same
/// session, at once.
#[test]
fn an_unknown_close_reason_asks_for_the_same_lease_at_once() {
    for cause in [Cause::Closed, Cause::Lost, Cause::Silent] {
        let (mut local, _events) = attached();
        local.command(interrupted(cause)).unwrap();
        local.reconnect_tick().unwrap();
        assert!(
            matches!(local.stage, Some(Stage::Issue { .. })),
            "{cause:?}"
        );
    }
}

/// PM, 12 Nov: a ready frame that is not the lease's gets one fresh lease and
/// a retry, not a stop. A second mismatch reads the catalog; nothing stops.
#[test]
fn a_stream_identity_mismatch_gets_one_fresh_lease_then_the_catalog() {
    let (mut local, _events) = attached();
    local.command(interrupted(Cause::Identity)).unwrap();
    local.reconnect_tick().unwrap();
    assert!(
        matches!(local.stage, Some(Stage::Issue { .. })),
        "no fresh lease after the first mismatch"
    );
    // The fresh lease's stream fails the same check.
    local.stage = None;
    local.submitted = false;
    leased(&mut local);
    local.command(interrupted(Cause::Identity)).unwrap();
    assert!(local.recovery.as_ref().is_some_and(Recovery::waiting));
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(
        matches!(local.stage, Some(Stage::Servers)),
        "the second mismatch asked for the same lease again"
    );
    assert_eq!(local.state.surface, Surface::Workspace);
    assert_eq!(local.state.status, RECONNECTING);
}

fn other_session(local: &mut Local, generation: &str) {
    local.targets.insert(
        "other".into(),
        Target {
            scope: ServerScope {
                server_id: "server".into(),
                generation: generation.into(),
            },
            live: "$2".into(),
        },
    );
}

/// PM, 12 Nov: one catalog that misses the session is never the end. A server
/// that lists other sessions is asked again; two seconds on it is believed.
#[test]
fn a_session_missing_from_a_server_that_lists_others_is_confirmed_before_it_ends() {
    for generation in ["generation", "generation-after-rebuild"] {
        let (mut local, events) = rediscovering();
        local.catalog_servers(vec![online("server", generation)]);
        other_session(&mut local, generation);
        assert!(local.reconnect_catalog().unwrap());
        assert!(
            local.recovery.as_ref().is_some_and(Recovery::waiting),
            "one catalog read ended the session"
        );
        let published = last_catalog(&events);
        assert_eq!(published.surface, Surface::Workspace);
        assert_eq!(published.status, RECONNECTING);
        assert_eq!(published.home_notice, None);
        // 1.9 s later it is still not believed; after 2 s it is.
        let since = &mut local.recovery.as_mut().unwrap().missing_since;
        *since = since.map(|at| at - Duration::from_millis(1900));
        other_session(&mut local, generation);
        assert!(local.reconnect_catalog().unwrap());
        assert!(local.recovery.is_some());
        let since = &mut local.recovery.as_mut().unwrap().missing_since;
        *since = since.map(|at| at - Duration::from_millis(200));
        other_session(&mut local, generation);
        assert!(local.reconnect_catalog().unwrap());
        assert!(local.recovery.is_none());
        let published = last_catalog(&events);
        assert_eq!(published.surface, Surface::Home);
        assert_eq!(
            published.home_notice.as_deref(),
            Some("“work” ended: its tmux session is no longer running.")
        );
    }
}

/// A server that is online with no session at all may be an owner the daemon
/// has only just rebuilt: it gets the long limit.
#[test]
fn a_server_that_lists_no_session_at_all_is_asked_for_thirty_seconds() {
    let (mut local, _events) = rediscovering();
    for (age, ended) in [(0, false), (29, false), (2, true)] {
        if let Some(since) = &mut local.recovery.as_mut().unwrap().missing_since {
            *since -= Duration::from_secs(age);
        }
        local.catalog_servers(vec![online("server", "generation-after-rebuild")]);
        assert!(local.reconnect_catalog().unwrap());
        assert_eq!(local.recovery.is_none(), ended, "after {age} more seconds");
    }
}

/// The count starts over when the session's server was away in between.
#[test]
fn the_missing_clock_starts_over_after_any_other_failure() {
    let (mut local, _events) = rediscovering();
    local.catalog_servers(vec![online("server", "generation")]);
    assert!(local.reconnect_catalog().unwrap());
    assert!(local.recovery.as_ref().unwrap().missing_since.is_some());
    local.reconnect_retry(Failure::Unreachable).unwrap();
    assert!(local.recovery.as_ref().unwrap().missing_since.is_none());
}

/// 1000 "panes-closed": the daemon said the last pane exited, so the first
/// catalog without the session is enough, and no lease is asked for it.
#[test]
fn a_session_whose_panes_closed_ends_on_the_first_catalog_without_it() {
    let (mut local, events) = attached();
    local.state.sessions = vec![Choice {
        id: "$1".into(),
        label: "work".into(),
        pane_count: Some(1),
        window_id: None,
        browser_icon: None,
        display_name_source: None,
        window_label: None,
        largest_window: None,
    }];
    local.command(interrupted(Cause::PanesClosed)).unwrap();
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Servers)));
    local.catalog_servers(vec![online("server", "generation")]);
    other_session(&mut local, "generation");
    assert!(local.reconnect_catalog().unwrap());
    assert!(local.recovery.is_none());
    assert_eq!(
        last_catalog(&events).home_notice.as_deref(),
        Some("“work” ended: its tmux session is no longer running.")
    );
}

/// Review of 9c0da9fe (G23): Refresh, Home and every rediscovery try start
/// over, so nothing the process remembered of the server list answers them.
#[test]
fn starting_over_drops_the_remembered_server_list() {
    use herdr_client::tmux_daemon::starts_over_on_this_thread as starts;
    let (mut local, _events) = attached();
    let before = starts();
    local.restart_discovery(false).unwrap();
    assert_eq!(starts(), before + 1, "a restart kept the remembered list");
    local.home(8).unwrap();
    assert_eq!(starts(), before + 2, "Home kept the remembered list");
}

/// Reconnect, 19 Nov 2026: the Mac woke or the network is back. A recovery
/// waiting out a long backoff (30 s over SSH) tries now, the backoff starts
/// over, and the route is proven again rather than trusted.
#[test]
fn a_wake_or_a_network_back_tries_at_once_and_starts_the_backoff_over() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    local.recovery.as_mut().unwrap().local_record = None;
    for _ in 0..12 {
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.reconnect_tick().unwrap();
        local.reconnect_retry(Failure::Unreachable).unwrap();
    }
    let due = local.recovery.as_ref().unwrap().due.unwrap();
    assert!(due > Instant::now() + Duration::from_secs(20));
    local.reconnect_tick().unwrap();
    assert!(local.stage.is_none(), "tried before the backoff was over");
    crate::tmux_snapshot::connection::network_watch::simulate_wake();
    local.reconnect_tick().unwrap();
    assert!(local.stage.is_some(), "the wake did not try at once");
    assert_eq!(local.recovery.as_ref().unwrap().attempt(), 1);
    // That try failed too: the next waits the first step, not 30 s.
    let before = Instant::now();
    local.reconnect_retry(Failure::Unreachable).unwrap();
    assert_eq!(delay(&local, before), 250);
    // The same epoch is no reason to hurry again.
    local.reconnect_tick().unwrap();
    assert!(local.stage.is_none());
}

/// A stream that went silent may sit behind an SSH forward on a network that
/// went away: its first try proves the route instead of waiting on it.
#[test]
fn a_silent_stream_proves_its_route_on_the_first_try() {
    let (mut local, _events) = attached();
    local.reconnect_after(Cause::Silent).unwrap();
    assert!(local.recovery.as_ref().unwrap().rediscover_owner);
    let (mut local, _events) = attached();
    local.reconnect_after(Cause::Lost).unwrap();
    assert!(!local.recovery.as_ref().unwrap().rediscover_owner);
}

/// Only a wake after the drop is news: one from before it hurries nothing,
/// whether the stream dropped or never opened.
#[test]
fn a_wake_before_the_drop_does_not_hurry_its_recovery() {
    for begun_by in ["a drop", "a failed open"] {
        crate::tmux_snapshot::connection::network_watch::simulate_wake();
        let (mut local, _events) = attached();
        if begun_by == "a drop" {
            local.reconnect_after(Cause::Lost).unwrap();
        } else {
            let target = local.active.as_ref().unwrap().target.clone();
            local
                .reconnect_opening(target, None, Failure::Unreachable)
                .unwrap();
        }
        let recovery = local.recovery.as_mut().unwrap();
        recovery.local_record = None;
        recovery.due = Some(Instant::now() + Duration::from_secs(30));
        local.stage = None;
        local.reconnect_tick().unwrap();
        assert!(
            local.stage.is_none(),
            "{begun_by}: an old wake hurried a try"
        );
    }
}

/// A try that could not reach the daemon makes the next one look its owner
/// up again (the record may name a new port or token), on the same worker.
/// Without it the app asks the old address for ever.
#[test]
fn after_an_unreachable_try_the_next_one_rediscovers_the_owner() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(
        !local.worker.reset_pending(),
        "the first try trusts the route"
    );
    local.reconnect_retry(Failure::Unreachable).unwrap();
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    assert!(
        local.worker.reset_pending(),
        "the old route was asked again"
    );
}

/// A wake during the first wait, before any try failed: the route is proven
/// again, not trusted. A tunnel can outlive the network it ran over.
#[test]
fn a_wake_before_the_first_try_rediscovers_the_owner() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    let recovery = local.recovery.as_mut().unwrap();
    recovery.local_record = None;
    recovery.due = Some(Instant::now() + Duration::from_secs(30));
    assert!(!local.worker.reset_pending());
    crate::tmux_snapshot::connection::network_watch::simulate_wake();
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    assert!(
        local.worker.reset_pending(),
        "the route was trusted across the wake"
    );
}
