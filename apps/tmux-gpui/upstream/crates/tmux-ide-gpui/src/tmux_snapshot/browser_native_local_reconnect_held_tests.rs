//! #872: a 2.9.28 daemon closes the stream of a pane it holds back with its
//! own cause. Recovery reconnects as after a plain close, and keeps the hold
//! (when, how long, why) for the view; a person's retry says so to the daemon.
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
fn held(ms: u64, too_large: bool) -> Cause {
    Cause::Held {
        retry_in: Duration::from_millis(ms),
        too_large,
    }
}
/// The lease the recovery asks for next, and whether a person asked for it.
fn next_issue(local: &mut Local) -> bool {
    local.stage = None;
    local.submitted = false;
    local.reconnect_tick().unwrap();
    let Some(stage @ Stage::Issue { .. }) = &local.stage else {
        panic!("expected a lease request");
    };
    let CatalogAction::Issue {
        retry_asked_by_person,
        ..
    } = stage.action()
    else {
        panic!("expected an issue action");
    };
    assert!(matches!(
        stage,
        Stage::Issue { retry_asked_by_person: asked, .. } if *asked == retry_asked_by_person
    ));
    retry_asked_by_person
}

#[test]
fn a_held_pane_close_reconnects_as_a_plain_close_and_keeps_the_hold_for_the_view() {
    let (mut local, events) = attached();
    let before = Instant::now();
    local.command(interrupted(held(12_000, true))).unwrap();
    let after = Instant::now();
    let recovery = local.recovery.as_ref().unwrap();
    // As after a plain close the daemon sent: at once, from the start.
    assert_eq!(recovery.attempts, 0);
    assert!(recovery.due.unwrap() <= after);
    assert!(recovery.rebind.is_some());
    let hold = recovery.held().unwrap();
    assert_eq!(hold.retry_in, Duration::from_secs(12));
    assert!(hold.too_large);
    assert!(before <= hold.since && hold.since <= after);
    let published = last_catalog(&events);
    assert_eq!(published.pane_held, Some(hold));
    assert!(published.reconnect_attempt.is_some());
    // The next try is a lease for the same session, as after a plain close.
    assert!(!next_issue(&mut local));
    assert_eq!(local.recovery.as_ref().unwrap().held(), Some(hold));
    assert_eq!(last_catalog(&events).pane_held, Some(hold));
    // A second hold replaces the first.
    leased(&mut local);
    local.command(interrupted(held(4000, false))).unwrap();
    let second = local.recovery.as_ref().unwrap().held().unwrap();
    assert_eq!(
        (second.retry_in, second.too_large),
        (Duration::from_secs(4), false)
    );
    assert!(second.since >= hold.since);
}

#[test]
fn a_later_close_of_another_cause_or_a_ready_stream_ends_the_hold() {
    for cause in [
        Cause::Closed,
        Cause::Lost,
        Cause::Silent,
        Cause::Identity,
        Cause::ServerRetired,
        Cause::DaemonRestarting,
        Cause::PanesClosed,
    ] {
        let (mut local, events) = attached();
        local.command(interrupted(held(2000, false))).unwrap();
        assert!(local.recovery.as_ref().unwrap().held().is_some());
        leased(&mut local);
        local.command(interrupted(cause)).unwrap();
        assert_eq!(local.recovery.as_ref().unwrap().held(), None, "{cause:?}");
        assert_eq!(last_catalog(&events).pane_held, None, "{cause:?}");
    }
    let (mut local, events) = attached();
    local.command(interrupted(held(2000, false))).unwrap();
    leased(&mut local);
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
    assert_eq!(last_catalog(&events).pane_held, None);
}

/// "Retry now" marks the one lease issue it hurries; automatic tries never
/// carry the mark.
#[test]
fn a_person_s_retry_marks_only_the_next_lease_issue() {
    let (mut local, _events) = attached();
    local.command(interrupted(held(30_000, true))).unwrap();
    // An automatic try.
    assert!(!next_issue(&mut local));
    local.reconnect_retry(Failure::Unreachable).unwrap();
    assert!(local.recovery.as_ref().unwrap().waiting());
    // A click for another request does nothing.
    local.reconnect_now(local.state.request + 1).unwrap();
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    assert!(!next_issue(&mut local));
    local.reconnect_retry(Failure::Unreachable).unwrap();
    // The click: the next lease says a person asked.
    local.reconnect_now(local.state.request).unwrap();
    assert!(next_issue(&mut local));
    // The try after it is automatic again.
    local.reconnect_retry(Failure::Unreachable).unwrap();
    local.recovery.as_mut().unwrap().due = Some(Instant::now());
    assert!(!next_issue(&mut local));
}

/// A plain drop's retry is marked as well: the daemon decides what the mark
/// means, and an older daemon never sees it (`issue_body`).
#[test]
fn a_person_s_retry_after_a_plain_drop_is_marked_too() {
    let (mut local, _events) = attached();
    local.reconnect_start().unwrap();
    assert!(!next_issue(&mut local));
    local.reconnect_retry(Failure::Unreachable).unwrap();
    local.reconnect_now(local.state.request).unwrap();
    assert!(next_issue(&mut local));
}

/// Round 2 of #872's review: a try that fails without the daemon's held close
/// (the daemon stopped, crashed or went away) ends the hold, so the session
/// reads as any other drop and can reach "Offline". A new held close sets it
/// again while the daemon is up.
#[test]
fn a_try_that_fails_without_a_held_close_ends_the_hold() {
    for failure in [
        Failure::Unreachable,
        Failure::Away,
        Failure::Missing,
        Failure::Identity,
        Failure::Other,
    ] {
        let (mut local, events) = attached();
        local.command(interrupted(held(2000, true))).unwrap();
        assert!(local.recovery.as_ref().unwrap().held().is_some());
        local.reconnect_retry(failure).unwrap();
        assert_eq!(local.recovery.as_ref().unwrap().held(), None, "{failure:?}");
        let published = last_catalog(&events);
        assert_eq!(published.pane_held, None, "{failure:?}");
        assert!(published.reconnect_attempt.is_some(), "{failure:?}");
    }
    // The daemon is back and still holds the pane: the hold shows again.
    let (mut local, _events) = attached();
    local.command(interrupted(held(2000, true))).unwrap();
    local.reconnect_retry(Failure::Unreachable).unwrap();
    leased(&mut local);
    local.command(interrupted(held(4000, true))).unwrap();
    assert_eq!(
        local.recovery.as_ref().unwrap().held().map(|h| h.retry_in),
        Some(Duration::from_secs(4))
    );
}
