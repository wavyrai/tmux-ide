//! #714 with the 0.1.17 reconnect code in play: a window that is
//! reconnecting must not spin, and keys held for a reconnect poll only until
//! the hold ends. (The heartbeat's liveness deadline is checked on the
//! stream's own thread and never reaches this task.)
#![allow(clippy::unwrap_used)]
use super::Next;
use crate::tmux_snapshot::{
    SnapshotView, agent_spinner, browser, fit_test_support, pending_input::Target,
};
use core::prelude::v1::test;
use gpui::*;
use std::{sync::mpsc, time::Duration};

struct Host {
    snapshot: Entity<SnapshotView>,
    content: AnyView,
}
impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.content.clone())
    }
}

/// A workspace mounted as production mounts it, with its UI task running.
fn open(
    cx: &mut TestAppContext,
    sender: mpsc::SyncSender<browser::Command>,
) -> (Entity<SnapshotView>, &mut VisualTestContext) {
    let state = browser::State {
        surface: browser::Surface::Workspace,
        request: 7,
        ..Default::default()
    };
    let (host, cx) = cx.add_window_view(|window, cx| {
        let snapshot = cx.new(|cx| fit_test_support::fixture_view(window, cx, sender, 7, state));
        let content = agent_spinner::window_root(snapshot.clone(), window, cx).into();
        Host { snapshot, content }
    });
    cx.simulate_resize(size(px(520.), px(400.)));
    let snapshot = host.read_with(cx, |host, _| host.snapshot.clone());
    let mailbox: browser::Mailbox = Default::default();
    cx.update(|window, cx| {
        snapshot.update(cx, |view, cx| {
            // A live session the user is typing into.
            let mut state = view.browser_state.clone();
            state.input_ready = true;
            state.presence_revision = 1;
            state.selected_session = Some("session".into());
            state.input_targets = vec![Target {
                id: state.selected_pane.clone().unwrap(),
                token: "a".repeat(64),
            }];
            view.apply_browser_state(Some(state), cx);
            cx.spawn_in(window, async move |entity, cx| {
                super::run_browser(entity, mailbox, cx).await
            })
            .detach();
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    wakes_over(&snapshot, cx, Duration::from_millis(400));
    // The fixture's first fit waits for a frame of the new size, which no
    // daemon sends here, and its limit reads the real clock: end it.
    cx.update(|_, cx| snapshot.update(cx, |view, _| view.pending_input = None));
    wakes_over(&snapshot, cx, Duration::from_millis(100));
    (snapshot, cx)
}

/// Lets `time` pass in 16 ms steps, drawing as the window would, and
/// returns how often the UI task woke.
fn wakes_over(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext, time: Duration) -> u32 {
    let before = cx.update(|_, cx| snapshot.read(cx).idle_tick.wakes);
    for _ in 0..time.as_millis() / 16 {
        cx.executor().advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
        // A frame: it renders the view only if something notified it.
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
    }
    cx.update(|_, cx| snapshot.read(cx).idle_tick.wakes) - before
}

/// The stream drops: the last frame, read-only, with no input targets.
fn drop_the_stream(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext) {
    cx.update(|_, cx| {
        snapshot.update(cx, |view, cx| {
            let mut state = view.browser_state.clone();
            state.input_ready = false;
            state.retained_preview = true;
            state.reconnect_attempt = Some(1);
            state.input_targets.clear();
            view.apply_browser_state(Some(state), cx);
        })
    });
}

fn next(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> Next {
    let now = cx.executor().now();
    cx.update(|_, cx| snapshot.read(cx).tick_next(now))
}

/// A connected, idle workspace arms nothing; and while it reconnects for
/// 70 s (past every threshold of the connection slot) the task wakes a
/// handful of times, for the slot's changes, not 4,375 times.
#[gpui::test]
fn a_reconnecting_window_does_not_spin(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, cx) = open(cx, sender);
    assert_eq!(
        wakes_over(&snapshot, cx, Duration::from_secs(2)),
        0,
        "a connected, idle workspace woke the task"
    );
    assert_eq!(next(&snapshot, cx), Next::Idle);
    drop_the_stream(&snapshot, cx);
    assert!(
        snapshot.read_with(cx, |view, _| view.session_reconnecting_for().is_some()),
        "the fixture is reconnecting"
    );
    let wakes = wakes_over(&snapshot, cx, Duration::from_secs(70));
    assert!(wakes <= 12, "{wakes} wakes in 70 s of reconnecting");
    assert_eq!(next(&snapshot, cx), Next::Idle, "and nothing is armed");
    assert_eq!(
        wakes_over(&snapshot, cx, Duration::from_secs(10)),
        0,
        "a window that stays offline woke the task"
    );
}

/// Keys held for a reconnect poll for room, as any pending input does, and
/// only until the hold ends: after its limit the keys are refused and the
/// task is idle again.
#[gpui::test]
fn held_keys_poll_only_until_the_hold_ends(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, cx) = open(cx, sender);
    drop_the_stream(&snapshot, cx);
    wakes_over(&snapshot, cx, Duration::from_millis(200));
    let held = cx.update(|_, cx| {
        snapshot.update(cx, |view, _| {
            let held = view.reconnect_hold_takes_keys();
            view.idle_tick.nudge();
            held
        })
    });
    assert!(held, "the fixture holds keys for the reconnect");
    assert!(
        matches!(next(&snapshot, cx), Next::At(_)),
        "a hold polls while it waits"
    );
    let polling = wakes_over(&snapshot, cx, Duration::from_millis(320));
    assert!((15..=25).contains(&polling), "{polling} wakes in 320 ms");
    // The hold's limit (3 s, about 190 polls) reads the real clock, which
    // this test's clock does not move: age the hold past it instead.
    cx.update(|_, cx| {
        snapshot.update(cx, |view, _| {
            view.age_pending_input_by(Duration::from_millis(3100));
        })
    });
    wakes_over(&snapshot, cx, Duration::from_millis(100));
    assert!(
        snapshot.read_with(cx, |view, _| view.pending_input.is_none()),
        "the hold ended"
    );
    assert_eq!(next(&snapshot, cx), Next::Idle);
    // Only the connection slot's thresholds (2 s and 8 s) wake it now.
    let after = wakes_over(&snapshot, cx, Duration::from_secs(12));
    assert!(after <= 6, "{after} wakes in 12 s after the hold");
}
