//! #714: an idle window arms no 16 ms tick, and every way work can reach the
//! tick starts it again.
#![allow(clippy::unwrap_used)]
use super::GRACE;
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

/// Lets the grace period run out; the task must then stop waking.
fn settle(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext) {
    let steps = (GRACE.as_millis() / 16) as u32 + 10;
    wakes_over(snapshot, cx, steps);
    assert_eq!(
        wakes_over(snapshot, cx, 125),
        0,
        "the idle UI task kept ticking"
    );
}

/// After a wake source, the tick runs again: many wakes, not one.
fn assert_ticking(snapshot: &Entity<SnapshotView>, cx: &mut VisualTestContext, source: &str) {
    let wakes = wakes_over(snapshot, cx, 20);
    assert!(
        wakes >= 10,
        "{source} did not restart the tick ({wakes} wakes)"
    );
}

#[gpui::test]
fn an_idle_home_arms_no_tick(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    // Within the grace period after opening, the tick still runs.
    assert!(wakes_over(&snapshot, cx, 20) >= 10, "no tick after opening");
    settle(&snapshot, cx);
    let now = cx.executor().now();
    assert!(!cx.update(|_, cx| snapshot.read(cx).tick_wanted(now)));
}

#[gpui::test]
fn a_publication_restarts_the_tick(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    *mailbox.lock().unwrap() = Some(Some(home()));
    assert_ticking(&snapshot, cx, "a publication");
    settle(&snapshot, cx);
}

#[gpui::test]
fn input_restarts_the_tick(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    cx.simulate_mouse_move(point(px(40.), px(40.)), None, Modifiers::none());
    assert_ticking(&snapshot, cx, "a mouse move");
    settle(&snapshot, cx);
    cx.simulate_event(ScrollWheelEvent {
        position: point(px(40.), px(40.)),
        ..Default::default()
    });
    assert_ticking(&snapshot, cx, "a scroll");
    settle(&snapshot, cx);
    // A key re-renders the window in tests as well, so this passes with
    // either the key listeners or the render nudge; mutants removing both fail.
    cx.simulate_keystrokes("f19");
    assert_ticking(&snapshot, cx, "a key");
    settle(&snapshot, cx);
    cx.simulate_modifiers_change(Modifiers::shift());
    assert_ticking(&snapshot, cx, "a modifier key");
}

#[gpui::test]
fn a_render_restarts_the_tick(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    cx.update(|window, cx| {
        snapshot.update(cx, |_, cx| cx.notify());
        window.draw(cx).clear(cx);
    });
    assert_ticking(&snapshot, cx, "a render");
}

#[gpui::test]
fn image_and_settings_changes_restart_the_tick(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    // In production this runs on the reader thread; the test scheduler
    // allows wakes from its own thread only.
    let store = cx.update(|_, cx| snapshot.read(cx).graphics.store.clone());
    store.invalidate_native(&["gone".into()]);
    assert_ticking(&snapshot, cx, "an image change");
    settle(&snapshot, cx);
    #[cfg(target_os = "macos")]
    {
        cx.update(|_, cx| snapshot.read(cx).chrome.simulate_settings_change());
        assert_ticking(&snapshot, cx, "an accessibility settings change");
    }
}

/// Queued work keeps the tick running past the grace period until flushed:
/// here a presence change waiting for room in the command queue.
#[gpui::test]
fn queued_work_outlasts_the_grace_period(cx: &mut TestAppContext) {
    // The fixture's own presence command fills the only slot.
    let (sender, receiver) = mpsc::sync_channel(1);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    cx.update(|_, cx| snapshot.update(cx, |view, _| view.presence.set_active(false)));
    cx.update(|_, cx| snapshot.read(cx).idle_tick.nudge());
    let steps = (GRACE.as_millis() / 16) as u32 * 2;
    assert!(
        wakes_over(&snapshot, cx, steps) >= steps / 2,
        "the tick stopped with a presence change still queued"
    );
    // Room in the queue: the next tick flushes, and the window goes idle.
    receiver.try_iter().for_each(drop);
    settle(&snapshot, cx);
    let flushed = receiver
        .try_iter()
        .any(|command| matches!(command, browser::Command::Presence { active: false, .. }));
    assert!(flushed, "the queued presence change was never sent");
}

/// Each kind of queued work keeps the tick armed after the grace period,
/// while nothing else would wake the task to flush it.
#[gpui::test]
fn each_kind_of_queued_work_arms_the_tick_past_the_grace(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    let wanted = |cx: &mut VisualTestContext| {
        let now = cx.executor().now();
        cx.update(|_, cx| snapshot.read(cx).tick_wanted(now))
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
        assert!(wanted(cx), "{name} did not arm the tick");
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
        assert!(!wanted(cx), "{name}: still armed once flushed");
    }
    // The renderer probe (TMUX_IDE_RENDERER_FIXTURE=1) ticks for as long as it runs.
    let probe = |on| super::super::renderer_probe::FORCED.with(|forced| forced.set(on));
    probe(true);
    assert!(wanted(cx), "the renderer probe did not arm the tick");
    probe(false);
    assert!(!wanted(cx));
}

#[gpui::test]
fn a_mouse_press_restarts_the_tick(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    cx.simulate_mouse_down(
        point(px(40.), px(40.)),
        MouseButton::Left,
        Modifiers::none(),
    );
    assert_ticking(&snapshot, cx, "a mouse press");
}

/// A key nudges the task through the root's listeners alone, before any
/// render: some keys the terminal handles notify nothing (#714 review r2).
#[gpui::test]
fn key_down_and_up_nudge_without_a_render(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, mailbox, cx) = open(cx, sender);
    settle(&snapshot, cx);
    let key = Keystroke::parse("f19").unwrap();
    mailbox.take_activity();
    cx.update(|window, cx| {
        window.dispatch_event(
            PlatformInput::KeyDown(KeyDownEvent {
                keystroke: key.clone(),
                is_held: false,
                prefer_character_input: false,
                layout: None,
            }),
            cx,
        );
    });
    assert!(mailbox.has_activity(), "key down");
    mailbox.take_activity();
    cx.update(|window, cx| {
        window.dispatch_event(
            PlatformInput::KeyUp(KeyUpEvent {
                keystroke: key,
                layout: None,
            }),
            cx,
        );
    });
    assert!(mailbox.has_activity(), "key up");
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

/// Activity left by a nudge while the task was busy arms the tick even with
/// the grace run out and nothing queued.
#[test]
fn pending_activity_arms_the_tick() {
    let mailbox = browser::MailboxSlot::default();
    assert!(!super::arm_tick(&mailbox, || false));
    mailbox.set_idle(false);
    mailbox.nudge();
    assert!(super::arm_tick(&mailbox, || false));
}

/// Deactivating the window wakes the task without a draw: a minimized
/// window may not draw, and its background transition must still be sent.
#[gpui::test]
fn deactivation_wakes_the_task_without_a_draw(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (snapshot, _mailbox, cx) = open(cx, sender);
    cx.update(|window, _| window.activate_window());
    settle(&snapshot, cx);
    let before = cx.update(|_, cx| snapshot.read(cx).idle_tick.wakes);
    cx.deactivate_window();
    let after = cx.update(|_, cx| snapshot.read(cx).idle_tick.wakes);
    assert!(after > before, "deactivation did not wake the task");
}
