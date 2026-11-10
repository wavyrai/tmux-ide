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
    // Many publications queue behind a full test channel; read the state itself.
    ended_on_home(&local, GIVE_UP);
}

/// Ended on Home, unavailable, with a message that says what to do.
fn ended_on_home(local: &Local, message: &str) {
    assert!(local.recovery.is_none());
    assert!(local.stage.is_none());
    assert_eq!(local.state.surface, Surface::Home);
    assert!(local.state.home_phase == HomePhase::Unavailable);
    assert_eq!(local.state.status, message);
}

/// Review round 1, item 1: a session that is listed but whose reopening keeps
/// failing must not refill the budget. The reviewer's probe: list, then fail,
/// up to 200 times.
#[test]
fn a_listed_session_that_keeps_failing_to_open_still_stops() {
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
        if local.recovery.is_some() {
            rediscover(&mut local);
        }
        cycles += 1;
    }
    assert_eq!(cycles, usize::from(MAX_OTHERS) + 1);
    ended_on_home(&local, GIVE_UP);
}

/// Review round 1, item 2: identity failures are bounded too.
#[test]
fn a_local_identity_mismatch_that_never_clears_stops() {
    let (mut local, _events) = attached();
    through_the_update(&mut local);
    let mut tries = 0;
    while local.recovery.is_some() && tries < 200 {
        local
            .reconnect_retry(Failure::of(&E::IdentityChanged))
            .unwrap();
        if local.recovery.is_some() {
            rediscover(&mut local);
        }
        tries += 1;
    }
    assert_eq!(tries, usize::from(MAX_OTHERS) + 1);
    ended_on_home(&local, GIVE_UP);
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

/// Keys typed during the rediscovery hold are refused and latched, and nothing
/// is sent when the session is back.
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
    view.read_with(cx, |view, _| assert!(view.input_interrupted));
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
