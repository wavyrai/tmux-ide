#![allow(clippy::unwrap_used)]
//! Card #878: each way the terminal loop still ends while its window is
//! open. Each test ends the real loop (`start_events`) through one exit, with
//! a window built from the same fixture as the window's own tests, and shows
//! what the window is left with.
use super::*;
use crate::tmux_snapshot::{SnapshotView, browser_ui::Selection, fit_test_support::fixture_view};
use gpui::{Entity, TestAppContext, VisualTestContext};
use herdr_client::tmux_handoff::{Event, Handoff};
use serde_json::json;
use std::{
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const WAIT: Duration = Duration::from_secs(5);
const LOST: &str = "Connection lost. Reopen Tmux IDE to reconnect.";

fn pane(id: &str) -> Choice {
    Choice {
        id: id.into(),
        label: "Pane".into(),
        pane_count: None,
        window_id: Some("window-a".into()),
        browser_icon: None,
        display_name_source: None,
        window_label: None,
        largest_window: None,
    }
}
/// The window as it is with a terminal open at request 7.
fn window(
    cx: &mut TestAppContext,
    sender: mpsc::SyncSender<Command>,
) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        fixture_view(
            window,
            cx,
            sender,
            7,
            State {
                request: 7,
                surface: Surface::Workspace,
                input_ready: true,
                sessions: vec![pane("session-a")],
                panes: vec![pane("pane-a"), pane("pane-b")],
                selected_session: Some("session-a".into()),
                ..State::default()
            },
        )
    })
}
/// Waits for the loop to close its mailbox, the window's sign that it ended.
fn ended(mailbox: &Mailbox) -> bool {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if matches!(mailbox.lock().unwrap().take(), Some(None)) {
            return true;
        }
        thread::sleep(Duration::from_millis(5));
    }
    false
}
/// The window takes the closed mailbox and is left with dead terminals: no
/// command sender, the "Connection lost" message, and a later selection goes
/// nowhere. Nothing publishes again: only a new app starts a new loop.
fn left_dead(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, mailbox: &Mailbox) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.apply_browser_state(None, cx);
            assert!(view.browser_commands.is_none());
            assert_eq!(view.browser_state.status, LOST);
            view.select(Selection::Pane("pane-b".into()), window, cx);
            assert!(view.browser_commands.is_none());
            assert!(view.frame.is_none());
            assert_eq!(view.browser_state.status, LOST);
        });
    });
    thread::sleep(Duration::from_millis(500));
    assert!(mailbox.lock().unwrap().is_none(), "something published");
}

/// Exit `REFUSED`: the catalog takes no command for 2 s (its queue of 32 is
/// full and it drains nothing), so `watch::Commands::send` fails.
#[gpui::test]
fn a_catalog_that_stalls_for_two_seconds_ends_the_loop(cx: &mut TestAppContext) {
    let (sender, stuck) = mpsc::sync_channel(1);
    sender.try_send(Command::Refresh { request: 0 }).unwrap();
    let commands = watch::Commands::new(sender, thread::current());
    let (events, receiver) = mpsc::sync_channel(8);
    let bridge = start_events(Default::default(), receiver, true, move || {
        move |command| commands.send(command)
    });
    let mailbox = bridge.mailbox.clone();
    // The window's first focus change is passed on to the catalog.
    let (view, cx) = window(cx, bridge.commands);
    assert!(ended(&mailbox), "the loop outlived a stalled catalog");
    left_dead(&view, cx, &mailbox);
    drop((events, stuck));
}

/// Exit `CLOSED`: the catalog actor ended (it returned or unwound), which
/// drops its event sender.
#[gpui::test]
fn a_catalog_that_goes_away_ends_the_loop(cx: &mut TestAppContext) {
    let (events, receiver) = mpsc::sync_channel::<Incoming>(8);
    let (commands, _taken) = mpsc::channel();
    let bridge = start_events(Default::default(), receiver, true, move || {
        move |command| commands.send(command).map_err(|_| Error::Invalid("gone"))
    });
    let mailbox = bridge.mailbox.clone();
    let (view, cx) = window(cx, bridge.commands);
    let actor = thread::spawn(move || {
        let _events = events;
        panic!("a fault in the catalog actor");
    });
    assert!(actor.join().is_err());
    assert!(ended(&mailbox), "the loop outlived its catalog");
    left_dead(&view, cx, &mailbox);
}

fn capability() -> Box<Handoff> {
    let now = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    Box::new(Handoff::parse(&serde_json::to_vec(&json!({"descriptor":{"protocolVersion":2,"webSocketUrl":"ws://127.0.0.1:9/v2/terminal/pane-streams/redeem","subprotocol":herdr_client::tmux_stream::SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":"e01ce8ee-74d8-40d0-9a59-a096050a6ade","requestId":"b987f903-e864-43dd-8591-8d0a464ca6e8","expiresAt":now + 60_000,"panes":["pane-a"],"effectiveViewerMode":"interactive"},"origin":"http://127.0.0.1:4000","hostClientId":"native.test","workspaceName":"workspace","selectedPane":"pane-a"})).unwrap()).unwrap())
}

/// Exit `STALE`: an open older than the catalog's request.
#[gpui::test]
fn an_open_older_than_its_catalog_ends_the_loop(cx: &mut TestAppContext) {
    let (events, receiver) = mpsc::sync_channel(8);
    let (commands, _taken) = mpsc::channel();
    let bridge = start_events(Default::default(), receiver, true, move || {
        move |command| commands.send(command).map_err(|_| Error::Invalid("gone"))
    });
    let mailbox = bridge.mailbox.clone();
    let (view, cx) = window(cx, bridge.commands);
    let catalog = State {
        request: 7,
        ..State::default()
    };
    events.send(Incoming::Catalog(Box::new(catalog))).unwrap();
    events
        .send(Incoming::Handoff(Event::Open {
            version: 1,
            id: "b987f903-e864-43dd-8591-8d0a464ca6e8".into(),
            request: 6,
            live_session_id: "session-a".into(),
            capability: capability(),
        }))
        .unwrap();
    assert!(ended(&mailbox), "the loop took a stale open");
    left_dead(&view, cx, &mailbox);
    drop(events);
}

/// Exit `WINDOW`, with the window open: while the loop waits on its catalog
/// (under the 2 s limit), the window's queue of 32 fills; a selection then
/// fails to send, and the window drops its only command sender. The loop
/// reads that as its window closing.
#[gpui::test]
fn a_full_window_queue_drops_the_sender_and_ends_the_loop(cx: &mut TestAppContext) {
    let (gate, opened) = mpsc::channel::<()>();
    let (events, receiver) = mpsc::sync_channel::<Incoming>(8);
    let bridge = start_events(Default::default(), receiver, true, move || {
        move |_command| {
            let _ = opened.recv_timeout(WAIT);
            Ok(())
        }
    });
    let mailbox = bridge.mailbox.clone();
    let (view, cx) = window(cx, bridge.commands);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let sender = view.browser_commands.clone().unwrap();
            thread::sleep(Duration::from_millis(100));
            let mut sent = 0;
            while sender.try_send(Command::Refresh { request: 0 }).is_ok() {
                sent += 1;
                assert!(sent <= 64, "the loop is not held");
            }
            drop(sender);
            view.select(Selection::Pane("pane-b".into()), window, cx);
            assert!(view.browser_commands.is_none());
            assert_eq!(view.browser_state.status, LOST);
        });
    });
    drop(gate);
    assert!(ended(&mailbox), "the loop outlived its sender");
    left_dead(&view, cx, &mailbox);
    drop(events);
}
