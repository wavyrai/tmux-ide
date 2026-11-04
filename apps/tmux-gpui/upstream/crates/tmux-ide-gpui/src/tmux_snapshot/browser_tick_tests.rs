#![allow(clippy::unwrap_used)]
use crate::tmux_snapshot::browser;
use core::prelude::v1::test;
use gpui::TestAppContext;
use std::{cell::Cell, rc::Rc, sync::mpsc};

/// Two seconds of 16 ms ticks on an idle, loaded Home must not re-render.
#[gpui::test]
fn an_idle_home_tick_never_re_renders(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                surface: browser::Surface::Home,
                home_phase: browser::HomePhase::Live,
                request: 7,
                ..Default::default()
            },
        )
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let notified = Rc::new(Cell::new(0u32));
    let count = notified.clone();
    let _watch = cx.update(|_, cx| cx.observe(&view, move |_, _| count.set(count.get() + 1)));
    for _ in 0..125 {
        cx.update(|_, cx| view.update(cx, |view, cx| view.browser_tick(cx)));
        cx.run_until_parked();
    }
    assert_eq!(notified.get(), 0, "an idle Home tick re-rendered");
}

/// #710: a publication reaches the view without waiting for the 16 ms tick.
#[gpui::test]
fn a_publication_is_applied_without_waiting_for_the_tick(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
    let home = browser::State {
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Live,
        request: 7,
        ..Default::default()
    };
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(window, cx, sender, 7, home.clone())
    });
    let mailbox: browser::Mailbox = Default::default();
    let running = mailbox.clone();
    cx.update(|window, cx| {
        view.update(cx, |_, cx| {
            cx.spawn_in(window, async move |entity, cx| {
                super::run_browser(entity, running, cx).await
            })
            .detach();
        })
    });
    cx.run_until_parked();
    *mailbox.lock().unwrap() = Some(Some(browser::State {
        status: "published".into(),
        ..home.clone()
    }));
    // No simulated time passes: only the publication can wake the loop.
    cx.run_until_parked();
    assert_eq!(
        cx.update(|_, cx| view.read(cx).browser_state.status.clone()),
        "published"
    );
    // The tick itself still runs for queued UI work.
    *mailbox.lock().unwrap() = Some(Some(browser::State {
        status: "second".into(),
        ..home
    }));
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(16));
    cx.run_until_parked();
    assert_eq!(
        cx.update(|_, cx| view.read(cx).browser_state.status.clone()),
        "second"
    );
}
