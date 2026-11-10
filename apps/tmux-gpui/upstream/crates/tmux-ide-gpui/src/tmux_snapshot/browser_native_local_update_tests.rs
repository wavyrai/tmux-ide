//! #r6: what an open session window does when the daemon behind it is updated.
//! The daemon restarts: the stream drops, the old record goes away, and a new
//! daemon with a new generation serves the same tmux server and session.
use super::*;
use herdr_client::tmux_daemon::Error as E;

/// Runs the recovery up to the moment the new daemon answers a lease for the
/// old generation, which it no longer knows. Returns the target before update.
fn through_the_update(local: &mut Local) -> Target {
    let target = local.active.as_ref().unwrap().target.clone();
    local.reconnect_start().unwrap();
    // First try: the old daemon is gone (refused, or its record changed).
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    local.reconnect_retry(Failure::of(&E::RecordChanged)).unwrap();
    // Second try reaches the new daemon, which has no scope for the old generation.
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    local.reconnect_retry(Failure::of(&E::RequestStatus(404))).unwrap();
    // Third try is rediscovery (a saved SSH profile is checked again first).
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    local.reconnect_tick().unwrap();
    assert!(matches!(
        local.stage,
        Some(Stage::Servers | Stage::VerifyProfile)
    ));
    target
}

fn new_daemon_lists(local: &mut Local, target: &Target) {
    let mut after = target.clone();
    after.scope.generation = "generation-after-update".into();
    local.targets.insert("token-after-update".into(), after);
}

#[test]
fn a_local_update_reconnects_the_same_session_but_shows_home_meanwhile() {
    let (mut local, events) = attached();
    let target = through_the_update(&mut local);
    // What the window shows during rediscovery: Home, loading, nothing selected.
    let seen = last_catalog(&events);
    assert_eq!(seen.surface, Surface::Home);
    assert!(seen.home_phase == HomePhase::Loading);
    assert_eq!(seen.selected_session, None);
    assert_eq!(seen.status, RECONNECTING);
    // The new daemon lists the same server and live session: it reopens on its own.
    new_daemon_lists(&mut local, &target);
    assert!(local.reconnect_catalog().unwrap());
    assert!(
        matches!(&local.stage, Some(Stage::Open { preferred, .. }) if preferred.as_deref() == Some("%2"))
    );
    assert!(local.recovery.is_some());
}

#[test]
fn a_different_daemon_answering_during_rediscovery_gives_up() {
    // A stale record (the old daemon did not remove it) read while the new
    // daemon already answers on the same port proves a different identity.
    let (mut local, events) = attached();
    through_the_update(&mut local);
    local.reconnect_retry(Failure::of(&E::IdentityChanged)).unwrap();
    assert!(local.recovery.is_none());
    assert_eq!(last_catalog(&events).status, GIVE_UP);
}

#[test]
fn an_update_that_changes_the_protocol_gives_up_with_advice_that_cannot_help() {
    let (mut local, events) = attached();
    through_the_update(&mut local);
    local.reconnect_retry(Failure::of(&E::Incompatible(99))).unwrap();
    assert!(local.recovery.is_none());
    // "Refresh sessions" reaches the same incompatible daemon again.
    assert_eq!(last_catalog(&events).status, GIVE_UP);
}

#[test]
fn a_new_daemon_that_is_slow_to_serve_its_catalog_gives_up_after_three_errors() {
    let (mut local, events) = attached();
    through_the_update(&mut local);
    let mut waited = Duration::ZERO;
    for _ in 0..3 {
        let before = Instant::now();
        local.reconnect_retry(Failure::of(&E::RequestStatus(503))).unwrap();
        assert!(local.recovery.is_some());
        waited += local.recovery.as_ref().unwrap().due.unwrap() - before;
        local.recovery.as_mut().unwrap().due = Some(Instant::now());
        local.reconnect_tick().unwrap();
    }
    local.reconnect_retry(Failure::of(&E::RequestStatus(503))).unwrap();
    assert!(local.recovery.is_none());
    assert_eq!(last_catalog(&events).status, GIVE_UP);
    // The new daemon had about this long to come up before the window gave up.
    eprintln!("r6: gave up after {waited:?} of backoff");
    assert!(waited < Duration::from_secs(16), "{waited:?}");
}

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
