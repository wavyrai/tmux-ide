//! #r6: an open session window across a daemon update. The daemon restarts:
//! the stream drops, the old record goes away, and a new daemon with a new
//! generation serves the same tmux server and session.
use super::*;
use herdr_client::tmux_daemon::Error as E;

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
        "Previous session identity changed or disappeared — select a session"
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
    for _ in 0..MAX_OTHERS {
        let before = Instant::now();
        local
            .reconnect_retry(Failure::of(&E::RequestStatus(503)))
            .unwrap();
        assert!(local.recovery.as_ref().is_some_and(Recovery::waiting));
        let delay = local.recovery.as_ref().unwrap().due.unwrap() - before;
        assert!(delay <= MAX_DELAY + Duration::from_millis(50), "{delay:?}");
        waited += delay;
        rediscover(&mut local);
    }
    assert_eq!(local.state.status, RECONNECTING);
    assert!(waited > Duration::from_secs(8 * 60), "{waited:?}");
    // The daemon came up: the same session is listed and reopened.
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    reopened_the_same_session(&local);
}

#[test]
fn rediscovery_stops_after_a_run_of_other_failures_with_no_listing() {
    let (mut local, _events) = attached();
    through_the_update(&mut local);
    for _ in 0..MAX_OTHERS {
        local.reconnect_retry(Failure::Other).unwrap();
        rediscover(&mut local);
    }
    local.reconnect_retry(Failure::Other).unwrap();
    assert!(local.recovery.is_none());
    // Many publications queue behind a full test channel; read the state itself.
    assert_eq!(local.state.status, GIVE_UP);
}

#[test]
fn a_listing_restarts_the_count_of_other_failures() {
    let (mut local, _events) = attached();
    let target = through_the_update(&mut local);
    for _ in 0..MAX_OTHERS {
        local.reconnect_retry(Failure::Other).unwrap();
        rediscover(&mut local);
    }
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    assert_eq!(local.recovery.as_ref().unwrap().others, 0);
    // Opening it fails: recovery goes on rather than stopping at once.
    local.reconnect_retry(Failure::Other).unwrap();
    assert!(local.recovery.as_ref().is_some_and(Recovery::waiting));
}

#[test]
fn a_session_gone_after_the_update_ends_recovery_on_home() {
    let (mut local, events) = attached();
    let mut target = through_the_update(&mut local);
    target.live = "$9".into();
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    assert!(local.recovery.is_none());
    let seen = last_catalog(&events);
    assert_eq!(seen.surface, Surface::Home);
    assert!(seen.home_phase == HomePhase::Unavailable);
}

/// Unchanged on purpose (owner decision pending): without a local record the
/// app accepts only the exact old generation, so a remote daemon update drops
/// the window to the session list.
#[test]
fn an_ssh_daemon_update_drops_the_window_to_select_a_session() {
    let (mut local, events) = attached();
    local.selected_profile = Some(herdr_client::tmux_daemon::SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Build".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: None,
        enabled: true,
    });
    let target = through_the_update(&mut local);
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    assert!(local.recovery.is_none());
    assert_eq!(
        last_catalog(&events).status,
        "Previous session identity changed or disappeared — select a session"
    );
}
