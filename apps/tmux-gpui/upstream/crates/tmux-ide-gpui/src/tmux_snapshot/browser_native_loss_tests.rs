#![allow(clippy::unwrap_used)]
//! Card #702 round 3: the drop paths, without a live daemon. Queued keys are
//! removed and reported in both branches, keys in flight are reported, keys are
//! reported only when some existed, and both branches hold the frame and ask
//! the catalog to re-issue the route.
use super::*;
use crate::tmux_snapshot::{browser::Surface, display_frame::DisplayFrame, keys::Input};
use std::sync::Arc;

fn live(state: &State) -> State {
    State {
        surface: Surface::Workspace,
        selected_pane: Some("left".into()),
        input_ready: true,
        frame: Some(DisplayFrame::Native(Arc::new(
            crate::terminal_painter::NativeFrame {
                rows: Vec::new(),
                width: 80,
                height: 24,
                cursor: None,
            },
        ))),
        ..state.clone()
    }
}
fn key(text: &str) -> Command {
    Command::Input {
        input_target: None,
        request: 3,
        id: "left".into(),
        input: Input::Text(text.into()),
    }
}
fn queue(commands: Vec<Command>) -> VecDeque<Command> {
    commands.into()
}
fn inputs(pending: &VecDeque<Command>) -> usize {
    pending
        .iter()
        .filter(|c| matches!(c, Command::Input { .. }))
        .count()
}
fn is_interrupted(command: &Command) -> bool {
    matches!(
        command,
        Command::NativeTerminalInterrupted { request: 3, .. }
    )
}

/// A stream the peer closed: not an input failure.
fn closed() -> NativeError {
    NativeError::Controller(herdr_client::tmux_controller::Error::Retired)
}

/// Soak, 12 Nov 2026: a frozen daemon never acknowledged a typed line. The
/// scheduler gave the key up, so nothing was "in flight" any more when the
/// poll failed with the input error, and the held frame did not say that keys
/// were lost. The error itself says a key went unanswered.
#[test]
fn a_stream_lost_to_an_unanswered_key_reports_it() {
    let (mut active, state, _observed, peer) = super::super::selection_tests::fixture(true);
    let state = live(&state);
    assert!(!active.input.busy());
    let mut hold = Hold::default();
    let unanswered = NativeError::Input(browser_native_input::Error::Scope);
    stream_lost(
        &active,
        &mut VecDeque::new(),
        &mut hold,
        &state,
        1,
        &unanswered,
    );
    assert_eq!(
        hold.lost_input(),
        Some(true),
        "an unanswered key was lost silently"
    );
    active.controller.retire();
    peer.join().unwrap();
}

#[test]
fn a_lost_stream_drops_and_reports_queued_keys() {
    let (mut active, state, _observed, peer) = super::super::selection_tests::fixture(true);
    let state = live(&state);
    let mut pending = queue(vec![key("a"), Command::Home { request: 9 }, key("b")]);
    let mut hold = Hold::default();
    let notice = stream_lost(&active, &mut pending, &mut hold, &state, 1, &closed());
    assert_eq!(inputs(&pending), 0, "queued keys would replay");
    assert_eq!(pending.len(), 1, "other work was dropped");
    assert!(is_interrupted(&notice));
    assert_eq!(
        hold.lost_input(),
        Some(true),
        "queued keys were lost silently"
    );

    // Nothing queued or in flight: no "keys not sent".
    let mut hold = Hold::default();
    stream_lost(
        &active,
        &mut VecDeque::new(),
        &mut hold,
        &state,
        1,
        &closed(),
    );
    assert_eq!(
        hold.lost_input(),
        Some(false),
        "reported keys that never existed"
    );
    active.controller.retire();
    peer.join().unwrap();
}

#[test]
fn a_lost_stream_reports_keys_in_flight() {
    let (mut active, state, _observed, peer) = super::super::selection_tests::fixture(true);
    let state = live(&state);
    active
        .input("left", None, Input::Text("a".into()), 1)
        .unwrap();
    assert!(
        active.input.busy(),
        "the fixture did not leave the key in flight"
    );
    let mut hold = Hold::default();
    stream_lost(
        &active,
        &mut VecDeque::new(),
        &mut hold,
        &state,
        1,
        &closed(),
    );
    assert_eq!(
        hold.lost_input(),
        Some(true),
        "a key in flight was lost silently"
    );
    let mut hold = Hold::default();
    command_failed(
        Some(&active),
        false,
        &mut VecDeque::new(),
        &mut hold,
        &state,
        1,
    );
    assert_eq!(
        hold.lost_input(),
        Some(true),
        "a key in flight was lost silently"
    );
    active.controller.retire();
    peer.join().unwrap();
}

#[test]
fn a_fatal_command_recovers_like_a_lost_stream() {
    let (mut active, state, _observed, peer) = super::super::selection_tests::fixture(true);
    let state = live(&state);
    let mut pending = queue(vec![key("a"), Command::Home { request: 9 }]);
    let mut hold = Hold::default();
    let notice = command_failed(Some(&active), false, &mut pending, &mut hold, &state, 1);
    assert!(
        notice.as_ref().is_some_and(is_interrupted),
        "no re-issue notice"
    );
    assert!(hold.active(), "the frame was not held");
    assert_eq!(inputs(&pending), 0, "queued keys would replay");
    assert_eq!(pending.len(), 1, "other work was dropped");
    assert_eq!(
        hold.lost_input(),
        Some(true),
        "queued keys were lost silently"
    );

    // N3: a failed key is lost; a failed non-key command with no keys is not.
    for (failed_input, lost) in [(true, true), (false, false)] {
        let mut hold = Hold::default();
        command_failed(
            Some(&active),
            failed_input,
            &mut VecDeque::new(),
            &mut hold,
            &state,
            1,
        );
        assert_eq!(
            hold.lost_input(),
            Some(lost),
            "failed input: {failed_input}"
        );
    }
    // No stream left to name: still held, no notice.
    let mut hold = Hold::default();
    assert!(command_failed(None, true, &mut VecDeque::new(), &mut hold, &state, 1).is_none());
    assert!(hold.active());
    active.controller.retire();
    peer.join().unwrap();
}

/// Review N2: busy or refused work is not a lost stream; anything else is.
#[test]
fn only_unusable_stream_errors_are_fatal() {
    use herdr_client::tmux_input::Error as Scheduler;
    let busy = Err(NativeError::Input(browser_native_input::Error::Scheduler(
        Scheduler::Busy,
    )));
    assert!(!fatal(&busy, None), "busy input recovered as a lost stream");
    let rejected = Err(NativeError::Owner(browser_native_owner::Error::Rejected));
    assert!(
        !fatal(&rejected, None),
        "an owner refusal recovered as a lost stream"
    );
    assert!(!fatal(&Ok(()), None));
    let invalid = Err(NativeError::Owner(browser_native_owner::Error::Invalid));
    assert!(
        fatal(&invalid, None),
        "an invalid owner reply kept the stream"
    );
}

/// A pane split in from another client re-leases the route, a bounded number
/// of times per request; other topology faults never do.
#[test]
fn a_pane_set_change_re_leases_a_bounded_number_of_times() {
    use herdr_client::{tmux_controller::Error as Controller, tmux_topology::Error as Topology};
    let unissued = NativeError::Controller(Controller::Topology(Topology::Unissued));
    let identity = NativeError::Controller(Controller::Topology(Topology::Identity));
    let mut releases = Releases::default();
    assert!(
        !releases.admit(&identity, 3, 0),
        "an identity fault re-leased"
    );
    for at in [0, 100, 200] {
        assert!(
            releases.admit(&unissued, 3, at),
            "a pane change at {at} ms was not re-leased"
        );
    }
    assert!(
        !releases.admit(&unissued, 3, 300),
        "a fourth re-lease within 10 s"
    );
    assert!(
        releases.admit(&unissued, 3, 10_001),
        "the window never reopened"
    );
    assert!(
        releases.admit(&unissued, 4, 10_002),
        "a new request inherited the count"
    );
}

/// Soak, 12 Nov 2026: after the daemon refused a stream as unavailable, the
/// next one showed frames but was never given input, and the window said
/// "Connecting…" until refreshed. Such a stream is replaced after ten seconds.
#[test]
fn a_stream_never_given_input_is_replaced_every_ten_seconds_six_times_at_most() {
    let mut stall = Stall::default();
    assert!(!stall.expired(7, "a", true, false, 0));
    assert!(!stall.expired(7, "a", true, false, 9_999));
    assert!(stall.expired(7, "a", true, false, 10_000));
    // The replacement starts its own wait.
    assert!(!stall.expired(7, "b", true, false, 10_100));
    assert!(!stall.expired(7, "b", true, false, 20_000));
    assert!(stall.expired(7, "b", true, false, 20_100));
    // Soak: the daemon granted input 21 s after it closed the stream. Four
    // more replacements cover a minute in all.
    let mut now = 20_100;
    for route in ["c", "d", "e", "f"] {
        assert!(!stall.expired(7, route, true, false, now + 100));
        now += 10_100;
        assert!(stall.expired(7, route, true, false, now), "{route}");
    }
    // A pane that takes no input at all is then left as it is.
    assert!(!stall.expired(7, "g", true, false, now + 100));
    assert!(!stall.expired(7, "g", true, false, now + 600_000));
    // Another request starts over.
    assert!(!stall.expired(8, "h", true, false, 900_000));
    assert!(stall.expired(8, "h", true, false, 910_000));
}

/// The limit is for one row of stalls. A stream that was given input ends
/// the row: hours later, in the same window, a stall is replaced again.
#[test]
fn a_stream_that_was_given_input_starts_the_count_over() {
    let mut stall = Stall::default();
    let mut now = 0;
    for route in ["a", "b", "c", "d", "e", "f"] {
        assert!(!stall.expired(7, route, true, false, now));
        now += 10_000;
        assert!(stall.expired(7, route, true, false, now));
    }
    assert!(!stall.expired(7, "g", true, false, now));
    assert!(!stall.expired(7, "g", true, false, now + 30_000));
    // Input is granted at last, and much later the stream stalls again.
    assert!(!stall.expired(7, "g", false, true, now + 31_000));
    let later = now + 3_600_000;
    assert!(!stall.expired(7, "h", true, false, later));
    assert!(stall.expired(7, "h", true, false, later + 10_000));
}

#[test]
fn a_stream_that_gets_input_or_is_inactive_is_never_replaced() {
    let mut stall = Stall::default();
    assert!(!stall.expired(7, "a", true, false, 0));
    // Input arrived, or the window went inactive: the wait is over.
    assert!(!stall.expired(7, "a", false, true, 5_000));
    assert!(!stall.expired(7, "a", true, false, 12_000));
    assert!(!stall.expired(7, "a", true, false, 21_999));
    assert!(stall.expired(7, "a", true, false, 22_000));
    let mut stall = Stall::default();
    for now in (0..120_000).step_by(1_000) {
        assert!(!stall.expired(7, "a", false, false, now));
    }
    // An inactive window is not a grant: it does not start the count over.
    let mut stall = Stall::default();
    for (route, now) in [
        ("a", 0),
        ("b", 10_000),
        ("c", 20_000),
        ("d", 30_000),
        ("e", 40_000),
        ("f", 50_000),
    ] {
        assert!(!stall.expired(7, route, true, false, now));
        assert!(stall.expired(7, route, true, false, now + 10_000));
    }
    assert!(!stall.expired(7, "g", false, false, 70_000));
    assert!(!stall.expired(7, "g", true, false, 70_100));
    assert!(!stall.expired(7, "g", true, false, 200_000));
}

/// The catalog picks its first reconnect step from why the stream ended, so
/// the notice carries it; a failed command is never the daemon speaking.
#[test]
fn the_notice_says_why_the_stream_ended() {
    let (active, state, _observed, _peer) = super::super::selection_tests::fixture(true);
    let state = live(&state);
    let retired = NativeError::Controller(herdr_client::tmux_controller::Error::Transport(
        herdr_client::tmux_stream::Error::Closed(herdr_client::tmux_stream::Close {
            code: 1012,
            reason: Some("tmux-server-retired".into()),
        }),
    ));
    let cause_of = |command: Command| match command {
        Command::NativeTerminalInterrupted { cause, .. } => cause,
        _ => unreachable!("not an interruption"),
    };
    let lost = |error: &NativeError| {
        stream_lost(
            &active,
            &mut VecDeque::new(),
            &mut Hold::default(),
            &state,
            1,
            error,
        )
    };
    assert_eq!(cause_of(lost(&retired)), Cause::ServerRetired);
    assert_eq!(cause_of(lost(&closed())), Cause::Lost);
    let failed = command_failed(
        Some(&active),
        false,
        &mut VecDeque::new(),
        &mut Hold::default(),
        &state,
        1,
    );
    assert_eq!(cause_of(failed.unwrap()), Cause::Lost);
}
