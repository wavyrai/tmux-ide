//! The status bar at the window's foot: Toggle Status Bar hides and restores
//! it for the session, and `[status_bar] show` in the config chooses where it starts.

#![allow(clippy::unwrap_used)]

use super::HerdrWindow;
use crate::{
    controls::Command,
    sidebar::layout_tests::{fixture_window, full_draw},
};
use gpui::{Bounds, Pixels, TestAppContext, px, size};

fn run(view: &gpui::Entity<HerdrWindow>, command: Command, cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| view.update(cx, |view, cx| view.command(command, window, cx)));
}

/// The status bar's bounds after a full draw, if it was drawn.
fn status_bar(cx: &mut gpui::VisualTestContext) -> Option<Bounds<Pixels>> {
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    cx.debug_bounds("connection-status")
}

fn terminal(cx: &mut gpui::VisualTestContext) -> Bounds<Pixels> {
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    cx.debug_bounds("terminal").unwrap()
}

#[gpui::test]
fn toggle_hides_and_restores_the_status_bar(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    assert!(status_bar(cx).is_some());

    run(&view, Command::ToggleStatusBar, cx);
    assert!(!view.read_with(cx, |view, _| view.status_bar_visible));
    assert!(status_bar(cx).is_none());

    run(&view, Command::ToggleStatusBar, cx);
    assert!(view.read_with(cx, |view, _| view.status_bar_visible));
    assert!(status_bar(cx).is_some());
}

/// Hiding the bar hands its rows to the terminal, which then reaches the
/// window's foot, and showing it takes them back.
#[gpui::test]
fn the_terminal_takes_the_rows_the_bar_gives_up(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(1000.), px(600.)));
    let shown = terminal(cx);
    let bar = status_bar(cx).unwrap();
    assert_eq!(shown.bottom(), bar.top());

    run(&view, Command::ToggleStatusBar, cx);
    let hidden = terminal(cx);
    assert_eq!(hidden.origin, shown.origin);
    assert_eq!(hidden.size.width, shown.size.width);
    assert_eq!(hidden.size.height, shown.size.height + bar.size.height);
    assert_eq!(hidden.bottom(), bar.bottom());

    run(&view, Command::ToggleStatusBar, cx);
    assert_eq!(terminal(cx), shown);
}

/// The real constructor reads `[status_bar] show` from the loaded config, and the
/// toggle still brings the bar back in a window that started without it.
#[cfg(feature = "integration-test")]
#[gpui::test]
fn a_new_window_starts_with_the_configured_status_bar(cx: &mut TestAppContext) {
    for configured in [true, false] {
        cx.update(|cx| {
            let mut appearance = crate::app::InitialAppearance::default();
            appearance.config.status_bar.show = configured;
            cx.set_global(appearance);
        });
        let (view, cx) = cx.add_window_view(|window, cx| {
            HerdrWindow::new(
                herdr_client::ConnectTarget::Socket("/unused-status-bar-test.sock".into()),
                window,
                cx,
                true,
            )
        });
        assert_eq!(
            view.read_with(cx, |view, _| view.status_bar_visible),
            configured
        );
        assert_eq!(status_bar(cx).is_some(), configured);
        run(&view, Command::ToggleStatusBar, cx);
        assert_eq!(status_bar(cx).is_some(), !configured);
    }
}
