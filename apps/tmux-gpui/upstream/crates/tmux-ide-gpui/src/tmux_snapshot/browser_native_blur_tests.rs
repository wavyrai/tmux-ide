#![allow(clippy::unwrap_used)]
//! Card #875: a line typed just before the window leaves (the soak's
//! `bg-fg-flap#661` over SSH, 24 Nov 2026). The line and the focus loss reach
//! the terminal loop in one turn: the loop waits up to 5 ms between turns and
//! a window command does not wake it. Keys are never sent once the window has
//! left, so the window must say they were not sent when it is back.
//!
//! These drive the real terminal loop (`start_events`) against a scripted
//! daemon stream on loopback. No daemon, tmux or SSH is started.
use super::super::*;
use super::harness::*;
use crate::tmux_snapshot::keys::Input;
use herdr_client::tmux_stream;
use std::{sync::atomic::Ordering, thread};

/// The soak's case: the line, then the focus loss, in one turn. The line is
/// not sent, and once the window is back it says so.
#[test]
fn a_line_queued_when_the_window_leaves_is_announced_as_not_sent() {
    let mut app = Loop::start();
    let mut commands = line(4402);
    commands.push(focus(false, 1));
    app.one_turn(0, commands);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    thread::sleep(Duration::from_millis(100));
    let sent_in_background = app.typed();
    app.send(focus(true, 2));
    let back = app.until("the window back with input", |state| {
        state.presence_revision == 2 && state.input_ready
    });
    thread::sleep(Duration::from_millis(100));
    let sent = [sent_in_background, app.typed()].concat();
    assert!(
        sent.is_empty(),
        "a key went out after the window left: {sent:?}"
    );
    assert_eq!(
        back.status, NOTICE,
        "line 4402 was neither sent nor announced as not sent"
    );
    // The next line goes out, once; line 4402 never follows it.
    for command in line(4403) {
        app.send(command);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sent = Vec::new();
    while sent.len() < 2 {
        sent.extend(app.typed());
        assert!(
            Instant::now() < deadline,
            "line 4403 was not sent: {sent:?}"
        );
        thread::sleep(Duration::from_millis(2));
    }
    assert!(sent[0].contains("4403"), "{sent:?}");
    assert!(sent[1].contains("Enter"), "{sent:?}");
    thread::sleep(Duration::from_millis(100));
    assert!(app.typed().is_empty(), "a line was sent twice");
}

/// A key that reaches the loop after the focus loss, in the same turn, is
/// refused there. It says so too.
#[test]
fn a_key_after_the_focus_loss_in_the_same_turn_is_announced_as_not_sent() {
    let mut app = Loop::start();
    let mut commands = vec![focus(false, 1)];
    commands.extend(line(4402));
    app.one_turn(0, commands);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    app.send(focus(true, 2));
    let back = app.until("the window back with input", |state| {
        state.presence_revision == 2 && state.input_ready
    });
    thread::sleep(Duration::from_millis(100));
    assert!(app.typed().is_empty(), "a key went out from the background");
    assert_eq!(back.status, NOTICE, "the refused line was not announced");
}

/// A window fit queued before the focus loss, or refused after it, is not a
/// lost key: no notice.
#[test]
fn a_fit_dropped_with_the_focus_loss_says_nothing() {
    let mut app = Loop::start();
    let fit = || Command::Input {
        request: 3,
        id: "left".into(),
        input_target: None,
        input: Input::Resize {
            cols: 9,
            rows: 2,
            cell_width: None,
            cell_height: None,
            cell_width_milli: None,
            cell_height_milli: None,
        },
    };
    app.one_turn(0, vec![fit(), focus(false, 1), fit()]);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    app.send(focus(true, 2));
    let back = app.until("the window back with input", |state| {
        state.presence_revision == 2 && state.input_ready
    });
    assert_eq!(back.status, "Connected");
}

/// A key the input scheduler holds back (eight earlier ones are unanswered,
/// a link's round trip) is cancelled by the focus loss: it says so too. A
/// held-back wheel step is not a key and says nothing.
#[test]
fn a_key_held_back_by_the_scheduler_is_announced_as_not_sent() {
    for (last, notice) in [(Input::Text("x".into()), true), (wheel(), false)] {
        let (mut active, mut state, _seen, peer) = selection_tests::fixture(true);
        for n in 0..8 {
            active
                .input("left", None, Input::Text(n.to_string()), 1)
                .unwrap();
        }
        active.input("left", None, last, 1).unwrap();
        assert!(active.input.waiting());
        let mut hold = hold::Hold::default();
        super::blur(
            &mut std::collections::VecDeque::new(),
            Some(&mut active),
            &mut hold,
        );
        active.input.focus_loss();
        super::poll(&mut active, &mut hold, &mut state, true, 2).unwrap();
        assert_eq!(state.status == NOTICE, notice, "{}", state.status);
        active.controller.retire();
        peer.join().unwrap();
    }
}
/// Typing is text, a key, bytes or a paste; a fit, a pointer event, a wheel
/// step or a history scroll is not.
#[test]
fn only_typing_counts_as_keys_not_sent() {
    let cases = [
        (Input::Text("a".into()), true),
        (Input::Key("Enter".into()), true),
        (Input::Bytes("1b".into()), true),
        (Input::Paste("a".into()), true),
        (wheel(), false),
        (Input::Scroll(-1), false),
        (
            Input::Mouse(crate::tmux_snapshot::pointer::Command::Cancel { gesture: 1 }),
            false,
        ),
    ];
    for (input, typing) in cases {
        let label = format!("{input:?}");
        let command = Command::Input {
            request: 3,
            id: "left".into(),
            input_target: None,
            input,
        };
        assert_eq!(super::typed(&command), typing, "{label}");
    }
    assert!(!super::typed(&focus(false, 1)));
}

/// Review round 1, item 1: the link drops while the window is away, after
/// the focus loss dropped a line. The catalog re-issues the stream, and the
/// window, back on the new stream, still says the line was not sent. The line
/// is never sent, on either stream.
#[test]
fn a_line_dropped_at_the_focus_loss_is_announced_after_a_reconnect_in_the_background() {
    let mut app = Loop::start_with(Script {
        close_on_release: true,
        ..Script::default()
    });
    let mut commands = line(4402);
    commands.push(focus(false, 1));
    app.one_turn(0, commands);
    app.until("the stream lost in the background", |state| {
        state.reconnect_attempt.is_some()
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
        "line 4402, dropped at the focus loss, announced after the reconnect",
    );
    thread::sleep(Duration::from_millis(100));
    assert!(
        app.typed().is_empty(),
        "a key was sent after the window left"
    );
}

/// Review round 1, item 2: in the loop, a key the input scheduler holds back
/// (eight earlier keys unanswered, a link's round trip) when the window
/// leaves. The focus loss cancels it; once back, the window says so, and the
/// key is never sent.
#[test]
fn a_key_held_back_by_the_scheduler_when_the_window_leaves_is_announced_in_the_loop() {
    let script = Script::default();
    script.hold_acks.store(true, Ordering::SeqCst);
    let mut app = Loop::start_with(script.clone());
    for n in 0..4 {
        for command in line(n) {
            app.send(command);
        }
    }
    app.send(text("held-back"));
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sent = Vec::new();
    while sent.len() < 8 {
        sent.extend(app.typed());
        assert!(Instant::now() < deadline, "8 keys did not go out: {sent:?}");
        thread::sleep(Duration::from_millis(2));
    }
    // Give the loop time to admit the ninth key: the scheduler holds it back.
    thread::sleep(Duration::from_millis(100));
    app.send(focus(false, 1));
    // The loop has taken the focus loss; the stream gives input up only once
    // the eight keys are answered, so answer them now.
    let deadline = Instant::now() + Duration::from_secs(5);
    while app.passed_on.load(Ordering::SeqCst) != 1 {
        assert!(Instant::now() < deadline, "the focus loss was not taken");
        thread::sleep(Duration::from_millis(2));
    }
    script.hold_acks.store(false, Ordering::SeqCst);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    app.send(focus(true, 2));
    noticed(&mut app, 3, 2, "the held-back key announced as not sent");
    thread::sleep(Duration::from_millis(100));
    sent.extend(app.typed());
    assert_eq!(sent.len(), 8, "{sent:?}");
    assert!(
        sent.iter().all(|input| !input.contains("held-back")),
        "the held-back key was sent after the window left"
    );
}

/// Review round 1, item 3: the soak's own drain, a fit queued with the line.
/// With the fit first or last, the line is still announced.
#[test]
fn a_line_queued_with_a_fit_before_or_after_it_is_announced() {
    let orders: [fn() -> Vec<Command>; 2] = [
        || {
            let mut commands = vec![fit()];
            commands.extend(line(4402));
            commands.push(focus(false, 1));
            commands
        },
        || {
            let mut commands = line(4402);
            commands.push(fit());
            commands.push(focus(false, 1));
            commands
        },
    ];
    for (index, order) in orders.into_iter().enumerate() {
        let mut app = Loop::start();
        app.one_turn(0, order());
        app.until("the window in the background", |state| {
            state.presence_revision == 1
        });
        app.send(focus(true, 2));
        let back = app.until("the window back with input", |state| {
            state.presence_revision == 2 && state.input_ready
        });
        assert_eq!(
            back.status, NOTICE,
            "order {index} (0: fit first, 1: fit last)"
        );
        thread::sleep(Duration::from_millis(100));
        assert!(app.typed().is_empty(), "order {index}: a key was sent");
    }
}

/// A stream lost, or failed by a command, before the window is back to read
/// the notice hands it to the next stream; one with no notice, or another
/// outcome, hands nothing on.
#[test]
fn a_lost_stream_hands_keys_not_sent_to_the_next_stream() {
    let lost = || {
        NativeError::Controller(herdr_client::tmux_controller::Error::Transport(
            tmux_stream::Error::ReadyTimeout,
        ))
    };
    let other = Some("Pane action was not applied");
    let cases = [
        (Some(super::KEYS_NOT_SENT), false),
        (Some(super::KEYS_NOT_SENT), true),
        (None, false),
        (None, true),
        (other, false),
        (other, true),
    ];
    for (outcome, failed) in cases {
        let notice = outcome == Some(super::KEYS_NOT_SENT);
        let (mut active, state, _seen, peer) = selection_tests::fixture(true);
        active.action_status.set(outcome);
        let mut hold = hold::Hold::default();
        let mut pending = std::collections::VecDeque::new();
        if failed {
            super::command_failed(Some(&active), false, &mut pending, &mut hold, &state, 1);
        } else {
            super::stream_lost(&active, &mut pending, &mut hold, &state, 1, &lost());
        }
        assert_eq!(
            hold.take_keys_not_sent(&active.session).is_some(),
            notice,
            "{outcome:?}, command failed {failed}"
        );
        active.controller.retire();
        peer.join().unwrap();
    }
}

/// Review N3 on card #871: the stream is already dead when the window leaves,
/// and the loop has not seen it yet. The line and the focus loss drain in the
/// same turn as before; the loop then finds the stream dead and re-issues it.
/// The window, back on the new stream, still says the line was not sent, and
/// the line is never sent.
#[test]
fn a_line_dropped_as_the_window_leaves_a_dead_stream_is_announced_on_the_next_one() {
    let script = Script::default();
    let mut app = Loop::start_with(script.clone());
    app.gate.store(true, Ordering::SeqCst);
    app.send(focus(true, 0));
    let mut commands = line(4402);
    commands.push(focus(false, 1));
    for command in commands {
        app.send(command);
    }
    // The loop is held inside this turn; the link dies before it goes on.
    script.close_now.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !script.closed.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "the stream did not close");
        thread::sleep(Duration::from_millis(2));
    }
    thread::sleep(Duration::from_millis(50));
    app.open.send(()).unwrap();
    app.until("the dead stream found", |state| {
        state.reconnect_attempt.is_some()
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
        "line 4402, dropped as the window left a dead stream, announced",
    );
    thread::sleep(Duration::from_millis(100));
    assert!(app.typed().is_empty(), "a key was sent");
}

/// Review round 2, item 1: another client splits a pane in while the window
/// is away, right after the focus loss dropped a line. The stream is
/// re-leased (a refresh of the same route), and the window, back on the new
/// stream, still says the line was not sent. The line is never sent.
#[test]
fn a_line_dropped_at_the_focus_loss_is_announced_after_a_re_lease_in_the_background() {
    let mut app = Loop::start_with(Script {
        add_pane_on_release: true,
        ..Script::default()
    });
    let mut commands = line(4402);
    commands.push(focus(false, 1));
    app.one_turn(0, commands);
    let deadline = Instant::now() + Duration::from_secs(5);
    while app.refreshes.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "the route was not re-leased");
        thread::sleep(Duration::from_millis(2));
    }
    app.reopen(3);
    app.send(focus(true, 2));
    noticed(
        &mut app,
        3,
        2,
        "line 4402, dropped at the focus loss, announced after a re-lease",
    );
    thread::sleep(Duration::from_millis(100));
    assert!(app.typed().is_empty(), "a key was sent");
}

/// Review round 2, N4: the stream is lost while the window is away, and the
/// catalog then opens another session. The notice belongs to the session the
/// keys were typed into, so the other session does not show it.
#[test]
fn keys_not_sent_in_one_session_are_not_announced_in_another() {
    const OTHER: &str = "live-session.98765432109876543210";
    let mut app = Loop::start_with(Script {
        close_on_release: true,
        ..Script::default()
    });
    let mut commands = line(4402);
    commands.push(focus(false, 1));
    app.one_turn(0, commands);
    app.until("the stream lost in the background", |state| {
        state.reconnect_attempt.is_some()
    });
    app.reopen_session(4, OTHER);
    app.send(focus(true, 2));
    let back = app.until("the other session back with input", |state| {
        state.request == 4 && state.presence_revision == 2 && state.input_ready
    });
    assert_eq!(back.status, "Connected");
    thread::sleep(Duration::from_millis(100));
    if let Some(Some(later)) = app.bridge.mailbox.lock().unwrap().take() {
        assert_eq!(later.status, "Connected", "a turn later");
    }
    assert!(app.typed().is_empty(), "a key was sent");
}

/// A stream takes over "keys not sent" only with the window back and input
/// in hand: in the background, or on a stream that cannot take input yet
/// (it may still be retired), the loop keeps it.
#[test]
fn only_a_stream_with_input_and_the_window_back_takes_over_keys_not_sent() {
    for (authority, foreground, taken) in [
        (true, false, false),
        (false, true, false),
        (true, true, true),
    ] {
        let (mut active, mut state, _seen, peer) = selection_tests::fixture(authority);
        let mut hold = hold::Hold::default();
        hold.carry_keys_not_sent(&active.session, super::KEYS_NOT_SENT);
        let _ = super::poll(&mut active, &mut hold, &mut state, foreground, 2);
        let label = format!("input {authority}, window back {foreground}");
        assert_eq!(active.action_status.is(NOTICE), taken, "{label}");
        assert_eq!(
            hold.take_keys_not_sent(&active.session).is_some(),
            !taken,
            "{label}: the loop no longer keeps it"
        );
        active.controller.retire();
        peer.join().unwrap();
    }
}
