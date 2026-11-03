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
