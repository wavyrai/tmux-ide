#![allow(clippy::unwrap_used)]
//! #713: the preview windows that are not the browsing shell (no arguments,
//! `--tmux-snapshot`, `--tmux-live-stdin`) render before anything installed
//! Bezel's theme; reading it then aborted the process.
use super::*;
use core::prelude::v1::test;
use std::sync::mpsc;

fn preview(cx: &mut TestAppContext, frame: bool) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (_, cx) = cx.add_window_view(|window, cx| {
        let mut view = fit_test_support::fixture_view(window, cx, sender, 1, Default::default());
        view.browsing = false;
        if !frame {
            view.frame = None;
        }
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.update(|_, cx| assert!(cx.try_global::<bezel_theme::Theme>().is_some()));
}

#[gpui::test]
fn the_no_argument_welcome_window_draws(cx: &mut TestAppContext) {
    preview(cx, false);
}

#[gpui::test]
fn a_snapshot_preview_window_draws(cx: &mut TestAppContext) {
    preview(cx, true);
}
