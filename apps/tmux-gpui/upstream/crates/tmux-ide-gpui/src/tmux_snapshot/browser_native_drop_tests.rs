#![allow(clippy::unwrap_used)]
//! Card #877: queued keys dropped without a notice when the stream is
//! retired (an owner operation waiting for its receipt, a re-lease), when the
//! window leaves after the stream was already revoked, and a paste cut by a
//! focus loss. Each must be reported once a stream of the session takes
//! input again, and never sent.
use super::super::*;
use super::harness::*;
use crate::tmux_snapshot::keys::Input;
use std::{sync::atomic::Ordering, thread};

/// What the window says when a stream was retired and replaced with keys
/// queued for it.
const DROPPED: &str = "Keys typed as the terminal reconnected were not sent. Type them again.";

fn no_line_sent(app: &Loop, n: u64) {
    thread::sleep(Duration::from_millis(100));
    let sent = app.typed();
    assert!(
        sent.iter().all(|input| !input.contains(&n.to_string())),
        "line {n} was sent: {sent:?}"
    );
}

/// Path 2: another client splits a pane in while a line is queued. The
/// stream is re-leased (the `structural` branch); the line is dropped and the
/// new stream says so.
#[test]
fn a_line_queued_as_the_route_is_re_leased_is_announced() {
    let script = Script::default();
    let mut app = Loop::start_with(script.clone());
    in_one_turn(&app, line(4402), || {
        script.add_pane_now.store(true, Ordering::SeqCst);
        wait("the split sent", || {
            !script.add_pane_now.load(Ordering::SeqCst)
        });
        thread::sleep(Duration::from_millis(50));
    });
    wait("the route re-leased", || {
        app.refreshes.load(Ordering::SeqCst) > 0
    });
    app.reopen(3);
    app.until("the re-leased stream says the line was not sent", |state| {
        state.request == 3 && state.input_ready && state.status == DROPPED
    });
    no_line_sent(&app, 4402);
}

/// Path 1: a new window is asked for (an owner operation), and its stream
/// is retired while the operation waits for its receipt, with a line queued.
/// The line is dropped; the next stream of the session says so.
#[test]
fn a_line_queued_as_an_owner_operation_retires_the_stream_is_announced() {
    let script = Script {
        grant_geometry: true,
        ..Script::default()
    };
    let mut app = Loop::start_with(script.clone());
    app.send(focus(true, 0));
    let actions = app
        .until("pane actions", |state| state.pane_actions.is_some())
        .pane_actions
        .unwrap();
    app.send(Command::PaneAction {
        request: 3,
        id: actions.id,
        token: actions.token,
        action: crate::tmux_snapshot::pane_actions::Action::NewWindow,
    });
    wait("the owner operation sent", || {
        app.owner_actions.load(Ordering::SeqCst) > 0
    });
    in_one_turn(&app, line(4402), || {
        script.close_now.store(true, Ordering::SeqCst);
        wait("the stream closed", || script.closed.load(Ordering::SeqCst));
        thread::sleep(Duration::from_millis(50));
    });
    // The branch that keeps the operation's correlation: no held frame, no
    // re-lease.
    app.until("the stream retired while the receipt waits", |state| {
        state.status == "Terminal connection interrupted — recovering"
            && state.reconnect_attempt.is_none()
    });
    assert_eq!(app.refreshes.load(Ordering::SeqCst), 0);
    app.reopen(4);
    app.until("the next stream says the line was not sent", |state| {
        state.request == 4 && state.input_ready && state.status == DROPPED
    });
    no_line_sent(&app, 4402);
}

/// Path 3: the stream was lost and revoked; a line and the focus loss then
/// reach the loop in one turn, with no stream. The line is dropped; once the
/// window is back on the next stream, it says so.
#[test]
fn a_line_dropped_as_the_window_leaves_with_no_stream_is_announced() {
    let script = Script::default();
    let mut app = Loop::start_with(script.clone());
    script.close_now.store(true, Ordering::SeqCst);
    app.until("the stream lost", |state| state.reconnect_attempt.is_some());
    let mut commands = line(4402);
    commands.push(focus(false, 1));
    app.one_turn(0, commands);
    wait("the focus loss passed on", || {
        app.passed_on.load(Ordering::SeqCst) == 1
    });
    app.reopen(4);
    app.until("the new stream in the background", |state| {
        state.request == 4 && state.frame.is_some() && !state.retained_preview
    });
    app.send(focus(true, 2));
    noticed(
        &mut app,
        4,
        2,
        "line 4402, dropped with no stream, announced",
    );
    no_line_sent(&app, 4402);
}

/// A paste longer than one chunk, cut by the focus loss after its first
/// chunk: the rest is never sent, and once the window is back it says so.
#[test]
fn a_paste_cut_by_the_focus_loss_is_announced() {
    let script = Script::default();
    script.hold_acks.store(true, Ordering::SeqCst);
    let mut app = Loop::start_with(script.clone());
    app.send(Command::Input {
        request: 3,
        id: "left".into(),
        input_target: None,
        input: Input::Paste("p".repeat(4096)),
    });
    let sent = std::cell::RefCell::new(Vec::new());
    wait("the first chunk sent", || {
        sent.borrow_mut().extend(app.typed());
        !sent.borrow().is_empty()
    });
    let mut sent = sent.into_inner();
    app.send(focus(false, 1));
    wait("the focus loss passed on", || {
        app.passed_on.load(Ordering::SeqCst) == 1
    });
    script.hold_acks.store(false, Ordering::SeqCst);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    app.send(focus(true, 2));
    noticed(&mut app, 3, 2, "the cut paste announced");
    thread::sleep(Duration::from_millis(100));
    sent.extend(app.typed());
    assert_eq!(sent.len(), 1, "more than the first chunk was sent");
}

/// A retired stream reports typing that was queued or held back by the
/// scheduler, in its own words, and nothing for a fit or a wheel step. Its
/// queue is emptied either way.
#[test]
fn a_retired_stream_reports_typing_queued_or_held_back_and_nothing_else() {
    let cases = [
        (Some(text("a")), None, true),
        (Some(fit()), None, false),
        (None, Some(Input::Text("x".into())), true),
        (None, Some(wheel()), false),
    ];
    for (queued, held_back, reported) in cases {
        let label = format!("queued {}, held back {held_back:?}", queued.is_some());
        let (mut active, _state, _seen, peer) = selection_tests::fixture(true);
        if let Some(last) = held_back {
            for n in 0..8 {
                active
                    .input("left", None, Input::Text(n.to_string()), 1)
                    .unwrap();
            }
            active.input("left", None, last, 1).unwrap();
            assert!(active.input.waiting());
        }
        let mut pending: std::collections::VecDeque<Command> = queued.into_iter().collect();
        let mut hold = hold::Hold::default();
        super::retired(&mut active, &mut pending, &mut hold);
        assert!(pending.is_empty(), "{label}: input kept");
        assert!(!active.input.waiting(), "{label}: a key still waits");
        assert_eq!(
            hold.take_keys_not_sent(&active.session),
            reported.then_some(super::KEYS_DROPPED),
            "{label}"
        );
        active.controller.retire();
        peer.join().unwrap();
    }
}

/// A focus loss with no stream reports typing, and only typing, for the
/// session of the held stream, however the hold began; with nothing held
/// it has no session to report for.
#[test]
fn a_blur_with_no_stream_reports_typing_for_the_held_session() {
    let lost = || {
        NativeError::Controller(herdr_client::tmux_controller::Error::Transport(
            herdr_client::tmux_stream::Error::ReadyTimeout,
        ))
    };
    let cases = [
        (text("a"), Some(false), true),
        (text("a"), Some(true), true),
        (fit(), Some(false), false),
        (text("a"), None, false),
    ];
    for (queued, held_by_failure, reported) in cases {
        let label = format!("held by a failed command {held_by_failure:?}, typing {reported}");
        let (mut active, state, _seen, peer) = selection_tests::fixture(true);
        let mut hold = hold::Hold::default();
        let mut none = std::collections::VecDeque::new();
        match held_by_failure {
            Some(true) => {
                super::command_failed(Some(&active), false, &mut none, &mut hold, &state, 1);
            }
            Some(false) => {
                super::stream_lost(&active, &mut none, &mut hold, &state, 1, &lost());
            }
            None => {}
        }
        let mut pending = std::collections::VecDeque::from([queued]);
        super::blur(&mut pending, None, &mut hold);
        assert!(pending.is_empty(), "{label}: input kept");
        assert_eq!(
            hold.take_keys_not_sent(&active.session),
            reported.then_some(super::KEYS_NOT_SENT),
            "{label}"
        );
        active.controller.retire();
        peer.join().unwrap();
    }
}
