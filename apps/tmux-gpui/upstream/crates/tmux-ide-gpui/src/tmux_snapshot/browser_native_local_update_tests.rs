//! #r6: an open session window across a daemon update. The daemon restarts:
//! the stream drops, the old record goes away, and a new daemon with a new
//! generation serves the same tmux server and session.
use super::*;
use herdr_client::tmux_daemon::Error as E;
use std::sync::mpsc;

/// Runs the recovery up to the moment the new daemon answers a lease for the
/// old generation, which it no longer knows, and rediscovery begins. Returns
/// the target before the update.
fn through_the_update(local: &mut Local) -> Target {
    let target = local.active.as_ref().unwrap().target.clone();
    local.reconnect_start().unwrap();
    // First try: the old daemon is gone (refused, or its record changed).
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    local
        .reconnect_retry(Failure::of(&E::RecordChanged))
        .unwrap();
    // Second try reaches the new daemon, which has no scope for the old generation.
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    local
        .reconnect_retry(Failure::of(&E::RequestStatus(404)))
        .unwrap();
    rediscover(local);
    target
}

/// The next try, which is a rediscovery (a saved SSH profile is checked first).
fn rediscover(local: &mut Local) {
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(matches!(
        local.stage,
        Some(Stage::Servers | Stage::VerifyProfile)
    ));
}

fn new_daemon_lists(local: &mut Local, target: &Target) {
    let mut after = target.clone();
    after.scope.generation = "generation-after-update".into();
    local.targets.insert("token-after-update".into(), after);
}

fn reopened_the_same_session(local: &Local) {
    assert!(
        matches!(&local.stage, Some(Stage::Open { preferred, .. }) if preferred.as_deref() == Some("%2"))
    );
    assert!(local.recovery.is_some());
}

#[test]
fn a_local_update_reconnects_the_same_session_and_keeps_the_window_meanwhile() {
    let (mut local, events) = attached();
    let target = through_the_update(&mut local);
    // Rediscovery keeps the session window: no Home, no loading state.
    let seen = last_catalog(&events);
    assert_eq!(seen.surface, Surface::Workspace);
    assert!(seen.home_phase != HomePhase::Loading);
    assert_eq!(seen.selected_session.as_deref(), Some("$1"));
    assert_eq!(seen.selected_pane.as_deref(), Some("%2"));
    assert_eq!(seen.panes.len(), 2);
    assert_eq!(seen.status, RECONNECTING);
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    reopened_the_same_session(&local);
}

#[test]
fn a_stale_record_answered_by_the_new_daemon_retries_and_reopens_the_same_session() {
    // The old daemon was killed and left its record; the new one already
    // answers on that port, so the identity proof fails until it republishes.
    let (mut local, _events) = attached();
    let target = through_the_update(&mut local);
    for _ in 0..5 {
        local
            .reconnect_retry(Failure::of(&E::IdentityChanged))
            .unwrap();
        assert!(local.recovery.as_ref().is_some_and(Recovery::waiting));
        assert_eq!(local.state.status, RECONNECTING);
        rediscover(&mut local);
    }
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    reopened_the_same_session(&local);
}

#[test]
fn a_different_daemon_after_identity_retries_is_refused_not_adopted() {
    // Retrying never widens what may be reopened: another install's record
    // listing a session with the same ids is not this window's session.
    let (mut local, events) = attached();
    let target = through_the_update(&mut local);
    local
        .reconnect_retry(Failure::of(&E::IdentityChanged))
        .unwrap();
    rediscover(&mut local);
    local.recovery.as_mut().unwrap().local_record = Some(PathBuf::from(
        "/nonexistent-reconnect-test/another-install.json",
    ));
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    assert!(local.recovery.is_none());
    assert!(!matches!(local.stage, Some(Stage::Open { .. })));
    assert_eq!(
        last_catalog(&events).status,
        "That session is gone or was replaced. Choose a session."
    );
}

#[test]
fn an_update_that_changes_the_protocol_says_to_update_the_app() {
    for during_rebind in [true, false] {
        let (mut local, events) = attached();
        if during_rebind {
            local.reconnect_start().unwrap();
        } else {
            through_the_update(&mut local);
        }
        local
            .reconnect_retry(Failure::of(&E::Incompatible(99)))
            .unwrap();
        assert!(local.recovery.is_none());
        let seen = last_catalog(&events);
        assert_eq!(seen.status, UPDATE_APP);
        assert!(!seen.status.contains("Refresh"));
    }
}

#[test]
fn a_new_daemon_slow_to_serve_its_catalog_is_retried_with_a_capped_backoff() {
    let (mut local, _events) = attached();
    let target = through_the_update(&mut local);
    let mut waited = Duration::ZERO;
    for _ in 0..40 {
        let before = Instant::now();
        local
            .reconnect_retry(Failure::of(&E::RequestStatus(503)))
            .unwrap();
        assert!(local.recovery.as_ref().is_some_and(Recovery::waiting));
        let delay = local.recovery.as_ref().unwrap().due.unwrap() - before;
        assert!(delay <= Duration::from_millis(5050), "{delay:?}");
        waited += delay;
        rediscover(&mut local);
    }
    assert_eq!(local.state.status, RECONNECTING);
    assert!(waited > Duration::from_secs(150), "{waited:?}");
    // The daemon came up: the same session is listed and reopened.
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    reopened_the_same_session(&local);
}

/// Owner, 12 Nov 2026: recovery keeps trying for as long as the window is open.
/// This replaces the 20-failure budget of the earlier rounds.
#[test]
fn rediscovery_never_stops_on_other_failures_with_no_listing() {
    let (mut local, _events) = attached();
    through_the_update(&mut local);
    for _ in 0..200 {
        local.reconnect_retry(Failure::Other).unwrap();
        rediscover(&mut local);
    }
    still_reconnecting(&local);
}

/// Still on the session window, waiting for the next try.
fn still_reconnecting(local: &Local) {
    assert!(local.recovery.is_some());
    assert_eq!(local.state.surface, Surface::Workspace);
    assert!(local.state.home_phase != HomePhase::Unavailable);
    assert_eq!(local.state.status, RECONNECTING);
}

/// Ended on Home, unavailable, with a message that says what to do.
fn ended_on_home(local: &Local, message: &str) {
    assert!(local.recovery.is_none());
    assert!(local.stage.is_none());
    assert_eq!(local.state.surface, Surface::Home);
    assert!(local.state.home_phase == HomePhase::Unavailable);
    assert_eq!(local.state.status, message);
}

/// A session that is listed but whose reopening keeps failing is retried at
/// the capped backoff, never faster: list, then fail, 200 times.
#[test]
fn a_listed_session_that_keeps_failing_to_open_is_retried_at_the_cap() {
    let (mut local, _events) = attached();
    let target = through_the_update(&mut local);
    let mut cycles = 0;
    while local.recovery.is_some() && cycles < 200 {
        new_daemon_lists(&mut local, &target);
        assert!(local.reconnect_catalog().unwrap());
        // The lease for the reopened session fails.
        local
            .reconnect_retry(Failure::of(&E::RequestStatus(500)))
            .unwrap();
        let wait = local.recovery.as_ref().unwrap().due.unwrap() - Instant::now();
        assert!(cycles < 6 || wait > Duration::from_millis(4900), "{wait:?}");
        rediscover(&mut local);
        cycles += 1;
    }
    assert_eq!(cycles, 200);
    still_reconnecting(&local);
}

/// A local identity mismatch reads the record again on every try, so it is
/// retried like any other failure.
#[test]
fn a_local_identity_mismatch_that_never_clears_keeps_retrying() {
    let (mut local, _events) = attached();
    through_the_update(&mut local);
    let mut tries = 0;
    while local.recovery.is_some() && tries < 200 {
        local
            .reconnect_retry(Failure::of(&E::IdentityChanged))
            .unwrap();
        rediscover(&mut local);
        tries += 1;
    }
    assert_eq!(tries, 200);
    still_reconnecting(&local);
}

/// Review round 1, item 2: over SSH an identity failure in rediscovery may be
/// another machine answering, so it stops at once, as it did before.
#[test]
fn an_ssh_identity_failure_in_rediscovery_stops_at_once() {
    for error in [E::IdentityChanged, E::IdentityFormat] {
        let (mut local, _events) = attached();
        local.selected_profile = Some(herdr_client::tmux_daemon::SavedMachine {
            id: uuid::Uuid::new_v4().to_string(),
            label: "Build".into(),
            ssh_target: "fixture.invalid".into(),
            expected_environment_id: None,
            enabled: true,
        });
        through_the_update(&mut local);
        local.reconnect_retry(Failure::of(&error)).unwrap();
        ended_on_home(&local, SSH_IDENTITY);
    }
}

/// Review round 1, item 3: rediscovery also asks the fleet to read its routes
/// again, so a remote that failed with the old daemon is retried with the new.
#[test]
fn rediscovery_refreshes_the_background_fleet() {
    let (mut local, _events) = attached();
    assert!(!local.background_fleet.refresh_requested());
    through_the_update(&mut local);
    assert!(local.background_fleet.refresh_requested());
}

/// The user can leave the held window at any time: navigation ends recovery.
#[test]
fn navigation_during_the_hold_cancels_recovery() {
    let (mut local, events) = attached();
    through_the_update(&mut local);
    assert!(local.recovery.is_some());
    local.home(8).unwrap();
    assert!(local.recovery.is_none());
    let seen = last_catalog(&events);
    assert_eq!(seen.surface, Surface::Home);
    assert_eq!(seen.reconnect_attempt, None);
}

/// Keys typed during the rediscovery hold are refused, and nothing is sent
/// when the session is back. The latch they set lifts with the reconnect, so
/// typing again needs no click.
#[gpui::test]
fn keys_during_the_hold_are_refused_and_never_replayed(cx: &mut gpui::TestAppContext) {
    let (mut local, events) = attached();
    through_the_update(&mut local);
    let hold = last_catalog(&events);
    assert!(hold.reconnect_attempt.is_some());
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            State {
                request: 7,
                surface: Surface::Workspace,
                input_ready: true,
                ..State::default()
            },
        )
    });
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.apply_browser_state(Some(hold.clone()), cx);
            assert!(
                !view.offer_terminal_input(cx),
                "a key was accepted in the hold"
            );
            assert!(view.input_interrupted);
        })
    });
    while receiver.try_recv().is_ok() {}
    // The session is back.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let mut back = hold.clone();
            back.reconnect_attempt = None;
            back.input_ready = true;
            back.status = "Connected".into();
            view.apply_browser_state(Some(back), cx);
        })
    });
    let replayed: Vec<_> = receiver
        .try_iter()
        .map(|c| serde_json::to_value(c).unwrap())
        .filter(|c| c["type"] == "input" && c["input"]["kind"] != "resize")
        .collect();
    assert!(replayed.is_empty(), "{replayed:?}");
    view.read_with(cx, |view, _| assert!(!view.input_interrupted));
}

/// A latch that anything else set first (a cancelled gesture, a rejected
/// target) still needs the terminal click: only keys refused by a reconnect
/// are known to have gone nowhere.
#[gpui::test]
fn a_latch_set_before_the_drop_does_not_lift_with_the_reconnect(cx: &mut gpui::TestAppContext) {
    let (mut local, events) = attached();
    through_the_update(&mut local);
    let hold = last_catalog(&events);
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            State {
                request: 7,
                surface: Surface::Workspace,
                input_ready: true,
                ..State::default()
            },
        )
    });
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            // Interrupted while the stream was live.
            view.interrupt_input(cx);
            view.apply_browser_state(Some(hold.clone()), cx);
            assert!(!view.offer_terminal_input(cx));
            let mut back = hold.clone();
            back.reconnect_attempt = None;
            back.input_ready = true;
            view.apply_browser_state(Some(back), cx);
            assert!(view.input_interrupted, "an older latch was lifted");
        })
    });
}

#[test]
fn a_session_gone_after_the_update_ends_recovery_on_home() {
    let (mut local, events) = attached();
    let mut target = through_the_update(&mut local);
    target.live = "$9".into();
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    read_again_later(&mut local);
    assert!(local.recovery.is_none());
    // Home is loaded again, with a notice, not an empty window.
    let seen = last_catalog(&events);
    assert_eq!(seen.surface, Surface::Home);
    assert!(seen.home_phase == HomePhase::Loading);
    assert_eq!(
        seen.home_notice.as_deref(),
        Some("The session ended: its tmux session is no longer running.")
    );
}

fn ssh_profile(id: &str) -> herdr_client::tmux_daemon::SavedMachine {
    herdr_client::tmux_daemon::SavedMachine {
        id: id.into(),
        label: "Build".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: None,
        enabled: true,
    }
}

fn identity(
    instance: &str,
    environment: Option<&str>,
) -> herdr_client::tmux_daemon::CatalogIdentity {
    herdr_client::tmux_daemon::CatalogIdentity {
        instance_id: instance.into(),
        environment_id: environment.map(str::to_owned),
    }
}

const PROFILE: &str = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT: &str = "22222222-2222-4222-8222-222222222222";

/// An SSH window across a remote daemon update (owner, D). `before`/`after`
/// are the remote environment ids the catalog reported; `profile_after` the
/// saved machine then selected; the new daemon lists `listed`.
fn ssh_update(
    before: Option<&str>,
    after: Option<&str>,
    profile_after: &str,
    listed: impl FnOnce(&mut Target),
) -> (Local, mpsc::Receiver<Incoming>) {
    let (mut local, events) = attached();
    // A selected saved machine makes the source remote: no local record.
    local.selected_profile = Some(ssh_profile(PROFILE));
    local.catalog_identity = Some(identity("old-instance", before));
    let mut target = through_the_update(&mut local);
    local.selected_profile = Some(ssh_profile(profile_after));
    local.catalog_identity = Some(identity("new-instance", after));
    target.scope.generation = "generation-after-update".into();
    listed(&mut target);
    local.targets.insert("token-after-update".into(), target);
    assert!(local.reconnect_catalog().unwrap());
    (local, events)
}

fn selects_a_session(local: &Local) {
    assert!(local.recovery.is_none());
    assert!(!matches!(local.stage, Some(Stage::Open { .. })));
    assert_eq!(
        local.state.status,
        "That session is gone or was replaced. Choose a session."
    );
}

#[test]
fn an_ssh_window_reopens_after_a_remote_update_on_the_same_machine_and_session() {
    let (local, _events) = ssh_update(Some(ENVIRONMENT), Some(ENVIRONMENT), PROFILE, |_| {});
    reopened_the_same_session(&local);
}

#[test]
fn same_ids_on_a_different_environment_are_refused() {
    let other = "33333333-3333-4333-8333-333333333333";
    let (local, _events) = ssh_update(Some(ENVIRONMENT), Some(other), PROFILE, |_| {});
    selects_a_session(&local);
}

#[test]
fn a_different_saved_machine_is_refused() {
    let other = "44444444-4444-4444-8444-444444444444";
    let (local, _events) = ssh_update(Some(ENVIRONMENT), Some(ENVIRONMENT), other, |_| {});
    selects_a_session(&local);
}

#[test]
fn another_tmux_server_or_a_restored_session_is_never_reopened() {
    // The same machine lists another server only: the session's own server
    // may still come back, so recovery waits for it and opens nothing else.
    let (local, _events) = ssh_update(Some(ENVIRONMENT), Some(ENVIRONMENT), PROFILE, |target| {
        target.scope.server_id = "other-server".into();
    });
    assert!(local.recovery.as_ref().is_some_and(Recovery::waiting));
    assert!(local.stage.is_none());
    // `servers upgrade` restores sessions on the server with new live ids:
    // the session this window showed has ended.
    let (mut local, _events) =
        ssh_update(Some(ENVIRONMENT), Some(ENVIRONMENT), PROFILE, |target| {
            target.live = "live-session.restored".into();
        });
    read_again_later(&mut local);
    assert!(local.recovery.is_none());
    assert!(!matches!(local.stage, Some(Stage::Open { .. })));
    assert!(local.state.home_notice.is_some());
}

#[test]
fn a_daemon_without_an_environment_id_keeps_todays_behaviour() {
    for (before, after) in [
        (None, None),
        (None, Some(ENVIRONMENT)),
        (Some(ENVIRONMENT), None),
    ] {
        let (local, _events) = ssh_update(before, after, PROFILE, |_| {});
        selects_a_session(&local);
    }
}

#[test]
fn an_ssh_environment_mismatch_error_is_an_identity_failure_and_stops_at_once() {
    use herdr_client::tmux_ssh::{DiscoveryError, Error as SshError, TransportError};
    let mismatch = E::Remote(Box::new(TransportError::Discovery(
        DiscoveryError::Descriptor(SshError::Environment),
    )));
    assert_eq!(Failure::of(&mismatch), Failure::Identity);
    let (mut local, _events) = attached();
    local.selected_profile = Some(ssh_profile(PROFILE));
    through_the_update(&mut local);
    local.reconnect_retry(Failure::of(&mismatch)).unwrap();
    ended_on_home(&local, SSH_IDENTITY);
}

/// #363 review, S10: only the environment mismatch is an identity failure.
/// A transient SSH discovery error (the machine away, a timeout, a cut
/// connection) and any other descriptor error must not end recovery with
/// "a different daemon answered".
#[test]
fn only_an_environment_mismatch_is_an_identity_failure_over_ssh() {
    use herdr_client::tmux_ssh::{DiscoveryError, Error as SshError, TransportError};
    let discovery = |error| E::Remote(Box::new(TransportError::Discovery(error)));
    for error in [
        DiscoveryError::Unreachable,
        DiscoveryError::Timeout,
        DiscoveryError::Cancelled,
        DiscoveryError::Exit,
        DiscoveryError::OutputLimit,
        DiscoveryError::MissingCli,
        DiscoveryError::Io(std::io::Error::from(std::io::ErrorKind::BrokenPipe)),
        DiscoveryError::Descriptor(SshError::Descriptor),
        DiscoveryError::Descriptor(SshError::Port),
        DiscoveryError::Descriptor(SshError::Target),
    ] {
        let label = format!("{error:?}");
        assert_ne!(Failure::of(&discovery(error)), Failure::Identity, "{label}");
    }
    assert_eq!(
        Failure::of(&discovery(DiscoveryError::Descriptor(
            SshError::Environment
        ))),
        Failure::Identity
    );
}
