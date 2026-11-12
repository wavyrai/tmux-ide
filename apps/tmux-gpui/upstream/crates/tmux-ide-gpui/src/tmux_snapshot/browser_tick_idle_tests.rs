//! #714: the browser task wakes only for a reason. An idle window never
//! wakes it; each way work can arrive wakes it once; queued work sets a
//! deadline or a poll, and nothing more.
#![allow(clippy::unwrap_used)]
use super::Next;
use crate::tmux_snapshot::{SnapshotView, agent_spinner, browser, fit_test_support};
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

fn home() -> browser::State {
    browser::State {
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Live,
        request: 7,
        ..Default::default()
    }
}

/// An idle Home mounted as production mounts it, with its UI task running.
fn open(
    cx: &mut TestAppContext,
    sender: mpsc::SyncSender<browser::Command>,
) -> (
    Entity<SnapshotView>,
    browser::Mailbox,
    &mut VisualTestContext,
) {
    let (host, cx) = cx.add_window_view(|window, cx| {
        let snapshot = cx.new(|cx| fit_test_support::fixture_view(window, cx, sender, 7, home()));
        let content = agent_spinner::window_root(snapshot.clone(), window, cx).into();
        Host { snapshot, content }
    });
    cx.simulate_resize(size(px(520.), px(400.)));
    let snapshot = host.read_with(cx, |host, _| host.snapshot.clone());
    let mailbox: browser::Mailbox = Default::default();
    let running = mailbox.clone();
    cx.update(|window, cx| {
        snapshot.update(cx, |_, cx| {
            cx.spawn_in(window, async move |entity, cx| {
                super::run_browser(entity, running, cx).await
            })
            .detach();
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
    (snapshot, mailbox, cx)
}

/// Lets `steps` tick periods pass and returns how often the UI task woke.
fn wakes_over(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext, steps: u32) -> u32 {
    let before = cx.update(|_, cx| snapshot.read(cx).idle_tick.wakes);
    for _ in 0..steps {
        cx.executor().advance_clock(Duration::from_millis(16));
        cx.run_until_parked();
    }
    cx.update(|_, cx| snapshot.read(cx).idle_tick.wakes) - before
}

/// The task goes idle: it must then not wake at all.
fn settle(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext) {
    wakes_over(snapshot, cx, 10);
    assert_eq!(
        wakes_over(snapshot, cx, 125),
        0,
        "the idle UI task kept waking"
    );
}

/// `source` wakes the task once or twice (its render may nudge again), not
/// a 16 ms tick's worth, and the task is idle again after it.
fn assert_woken(
    snapshot: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    name: &str,
    source: impl FnOnce(&mut VisualTestContext),
) {
    let before = cx.update(|_, cx| snapshot.read(cx).idle_tick.wakes);
    source(cx);
    wakes_over(snapshot, cx, 20);
    let wakes = cx.update(|_, cx| snapshot.read(cx).idle_tick.wakes) - before;
    assert!((1..=3).contains(&wakes), "{name}: {wakes} wakes in 320 ms");
    settle(snapshot, cx);
}

#[gpui::test]
fn an_idle_home_never_wakes_the_task(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    let now = cx.executor().now();
    assert_eq!(
        cx.update(|_, cx| snapshot.read(cx).tick_next(now)),
        Next::Idle
    );
}

#[gpui::test]
fn a_publication_wakes_the_task_once(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    assert_woken(&snapshot, cx, "a publication", |_| {
        *mailbox.lock().unwrap() = Some(Some(home()));
    });
}

#[gpui::test]
fn input_wakes_the_task_once(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    assert_woken(&snapshot, cx, "a mouse move", |cx| {
        cx.simulate_mouse_move(point(px(40.), px(40.)), None, Modifiers::none());
    });
    assert_woken(&snapshot, cx, "a scroll", |cx| {
        cx.simulate_event(ScrollWheelEvent {
            position: point(px(40.), px(40.)),
            ..Default::default()
        });
    });
    // A key re-renders the window in tests as well, so this passes with
    // either the key listeners or the render nudge; mutants removing both fail.
    assert_woken(&snapshot, cx, "a key", |cx| {
        cx.simulate_keystrokes("f19");
    });
    assert_woken(&snapshot, cx, "a modifier key", |cx| {
        cx.simulate_modifiers_change(Modifiers::shift());
    });
}

#[gpui::test]
fn a_render_wakes_the_task_once(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    assert_woken(&snapshot, cx, "a render", |cx| {
        cx.update(|window, cx| {
            snapshot.update(cx, |_, cx| cx.notify());
            window.draw(cx).clear(cx);
        });
    });
}

#[gpui::test]
fn image_and_settings_changes_wake_the_task_once(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    // In production this runs on the reader thread; the test scheduler
    // allows wakes from its own thread only.
    let store = cx.update(|_, cx| snapshot.read(cx).graphics.store.clone());
    assert_woken(&snapshot, cx, "an image change", |_| {
        store.invalidate_native(&["gone".into()]);
    });
    #[cfg(target_os = "macos")]
    {
        assert_woken(&snapshot, cx, "an accessibility settings change", |cx| {
            cx.update(|_, cx| snapshot.read(cx).chrome.simulate_settings_change());
        });
    }
}

/// Work waiting for room in the command queue polls every 16 ms until it is
/// sent: here a presence change.
#[gpui::test]
fn work_waiting_for_room_polls_until_sent(cx: &mut TestAppContext) {
    // The fixture's own presence command fills the only slot.
    let (sender, receiver) = mpsc::sync_channel(1);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    cx.update(|_, cx| snapshot.update(cx, |view, _| view.presence.set_active(false)));
    cx.update(|_, cx| snapshot.read(cx).idle_tick.nudge());
    let steps = 60;
    assert!(
        wakes_over(&snapshot, cx, steps) >= steps / 2,
        "the task stopped polling with a presence change still queued"
    );
    // Room in the queue: the next tick flushes, and the window goes idle.
    receiver.try_iter().for_each(drop);
    settle(&snapshot, cx);
    let flushed = receiver
        .try_iter()
        .any(|command| matches!(command, browser::Command::Presence { active: false, .. }));
    assert!(flushed, "the queued presence change was never sent");
}

/// A fit waiting to settle wakes the task at its deadline, not every 16 ms.
#[gpui::test]
fn a_settling_fit_sets_a_deadline_not_a_poll(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    let now = cx.executor().now();
    let next = cx.update(|_, cx| {
        snapshot.update(cx, |view, _| {
            let fit = |cols| crate::tmux_snapshot::geometry::Fit {
                request: 7,
                cols,
                rows: 24,
                pixels: (0, 0, 0, 0),
            };
            assert!(
                !view
                    .fit_settle
                    .ready(fit(80), Some((7, 100, 24)), false, now)
            );
            view.tick_next(now)
        })
    });
    assert_eq!(next, Next::At(now + Duration::from_millis(150)));
}
#[gpui::test]
fn each_kind_of_queued_work_sets_a_wake(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    let wanted = |cx: &mut VisualTestContext| {
        let now = cx.executor().now();
        cx.update(|_, cx| snapshot.read(cx).tick_next(now)) != Next::Idle
    };
    assert!(!wanted(cx), "nothing queued");
    type Queue = fn(&mut SnapshotView, std::time::Instant);
    let cases: [(&str, Queue); 7] = [
        ("held input", |view, _| {
            view.pending_input = Some(super::super::pending_input::Pending::held_for_test(7));
        }),
        ("a resize gesture", |view, _| {
            view.resize_gesture = super::super::divider::tests::busy_owner();
        }),
        ("a settling fit", |view, now| {
            let fit = |cols| super::super::geometry::Fit {
                request: 7,
                cols,
                rows: 24,
                pixels: (0, 0, 0, 0),
            };
            assert!(
                !view
                    .fit_settle
                    .ready(fit(80), Some((7, 100, 24)), false, now)
            );
        }),
        ("an attention close", |view, _| {
            view.attention.queue_cancel(7, 1)
        }),
        ("a debounced palette query", |view, now| {
            view.palette
                .debounce_for_test(now + Duration::from_millis(120));
        }),
        ("a palette close", |view, _| view.palette.close_for_test()),
        ("an image to repaint", |view, _| {
            view.graphics.store.invalidate_native(&["gone".into()]);
        }),
    ];
    for (name, queue) in cases {
        let now = cx.executor().now();
        cx.update(|_, cx| snapshot.update(cx, |view, _| queue(view, now)));
        assert!(wanted(cx), "{name} set no wake");
        // Flushed or expired by later ticks, the window goes idle again.
        cx.update(|_, cx| {
            snapshot.update(cx, |view, _| {
                view.pending_input = None;
                view.resize_gesture = Default::default();
                view.fit_settle.clear();
                view.attention = Default::default();
                view.palette = Default::default();
                let _ = view.graphics.store.take_changed();
            })
        });
        assert!(!wanted(cx), "{name}: still set once flushed");
    }
    // The renderer probe (TMUX_IDE_RENDERER_FIXTURE=1) ticks for as long as it runs.
    let probe = |on| super::super::renderer_probe::FORCED.with(|forced| forced.set(on));
    probe(true);
    assert!(wanted(cx), "the renderer probe set no wake");
    probe(false);
    assert!(!wanted(cx));
}

#[gpui::test]
fn a_mouse_press_wakes_the_task(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    assert_woken(&snapshot, cx, "a mouse press", |cx| {
        cx.simulate_mouse_down(
            point(px(40.), px(40.)),
            MouseButton::Left,
            Modifiers::none(),
        );
    });
}

/// A key nudges the task through the root's listeners alone, before any
/// render: some keys the terminal handles notify nothing (#714 review r2).
#[gpui::test]
fn key_down_and_up_nudge_without_a_render(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    let key = Keystroke::parse("f19").unwrap();
    // Renders still happen (dispatching draws a dirty window first), but
    // their nudge is off, so only the key listeners can mark activity.
    cx.update(|_, cx| snapshot.update(cx, |view, _| view.idle_tick.quiet_renders = true));
    let down = KeyDownEvent {
        keystroke: key.clone(),
        is_held: false,
        prefer_character_input: false,
        layout: None,
    };
    let up = KeyUpEvent {
        keystroke: key,
        layout: None,
    };
    for (name, event) in [
        ("key down", PlatformInput::KeyDown(down)),
        ("key up", PlatformInput::KeyUp(up)),
    ] {
        cx.update(|window, cx| {
            mailbox.take_activity();
            window.dispatch_event(event, cx);
            assert!(mailbox.has_activity(), "{name}");
        });
    }
}

/// A publication marks activity before anything draws.
#[gpui::test]
fn a_publication_marks_activity_before_any_draw(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    mailbox.take_activity();
    *mailbox.lock().unwrap() = Some(Some(home()));
    assert!(mailbox.has_activity());
}

/// Activity left by a nudge while the task was busy runs it at once, even
/// with nothing queued.
#[test]
fn pending_activity_runs_the_task_at_once() {
    let mailbox = browser::MailboxSlot::default();
    let now = std::time::Instant::now();
    assert_eq!(super::next_run(&mailbox, now, || Next::Idle), Next::Idle);
    mailbox.set_idle(false);
    mailbox.nudge();
    assert_eq!(super::next_run(&mailbox, now, || Next::Idle), Next::At(now));
}

/// Deactivating the window nudges the task without a draw: a minimized
/// window may not draw, and its background transition must still be sent.
#[gpui::test]
fn deactivation_nudges_the_task_without_a_draw(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    mailbox.take_activity();
    // Asserted inside the update: the test context draws once it returns,
    // and that render's own nudge would hide a missing one.
    cx.update(|_, cx| {
        snapshot.update(cx, |view, cx| view.activation_changed(false, cx));
        assert!(mailbox.has_activity());
    });
}
