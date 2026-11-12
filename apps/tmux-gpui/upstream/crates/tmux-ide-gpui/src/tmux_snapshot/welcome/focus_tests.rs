//! The welcome keeps the keyboard only while nothing is open over it: the
//! palette, About and the new-session dialog each hold it, and closing them
//! gives it back to the welcome's primary button.
#![allow(clippy::unwrap_used)]
use super::tests::{draw, fresh, home, shown};
use super::*;
use crate::tmux_snapshot::menu_bar::AboutApp;
use core::prelude::v1::test;

fn primary_focused(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> bool {
    cx.update(|window, cx| view.read_with(cx, |v, _| v.welcome.focus[1].is_focused(window)))
}

fn no_setup(rx: &std::sync::mpsc::Receiver<browser::Command>) -> bool {
    rx.try_iter()
        .all(|c| !matches!(c, browser::Command::LocalSetup { .. }))
}

#[gpui::test]
fn the_palette_over_the_welcome_takes_typing_and_return_runs_the_row(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    assert!(primary_focused(&view, cx));
    cx.simulate_keystrokes("f5");
    draw(cx);
    cx.simulate_input("about");
    draw(cx);
    assert!(view.read_with(cx, |v, _| v.picker.is_some()));
    cx.simulate_keystrokes("enter");
    draw(cx);
    view.read_with(cx, |v, _| {
        assert!(v.about.is_some(), "Return ran About Tmux IDE");
        assert!(v.welcome.open);
    });
    assert!(no_setup(&rx));
}

#[gpui::test]
fn about_over_the_welcome_holds_the_keyboard_and_gives_it_back(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    cx.dispatch_action(AboutApp);
    draw(cx);
    assert!(view.read_with(cx, |v, _| v.about.is_some()));
    // Return and Space with nothing reached, then Tab and Space, which on
    // the welcome would press Skip; in About they open the website.
    for keys in ["enter", "space", "tab space"] {
        cx.simulate_keystrokes(keys);
        draw(cx);
    }
    assert!(no_setup(&rx), "nothing under About started setup");
    view.read_with(cx, |v, _| {
        assert!(v.welcome.open, "Skip was not pressed under About");
        assert!(!v.welcome.welcomed);
    });
    assert!(view.read_with(cx, |v, _| v.about.is_some()));
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(view.read_with(cx, |v, _| v.about.is_none()));
    assert!(
        primary_focused(&view, cx),
        "the keyboard is back on the welcome"
    );
    // And the welcome answers it again.
    cx.simulate_keystrokes("enter");
    assert!(
        !no_setup(&rx),
        "Return on the welcome's primary starts setup"
    );
}

#[gpui::test]
fn escape_closes_about_over_the_welcome_at_once(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    cx.dispatch_action(AboutApp);
    draw(cx);
    cx.simulate_keystrokes("space enter");
    draw(cx);
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(view.read_with(cx, |v, _| v.about.is_none()));
    assert!(primary_focused(&view, cx));
    assert!(no_setup(&rx));
}

/// The welcome reopened from Commands on a live Home: the top row's New
/// session… opens its dialog, which lives in Home, so the welcome steps
/// aside (as its own Start new does) and the dialog has the keyboard.
#[gpui::test]
fn new_session_from_the_welcome_leaves_it_for_the_dialog(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(&dir));
    cx.update(|window, cx| view.update(cx, |v, cx| v.open_welcome(window, cx)));
    assert!(shown(cx));
    assert!(primary_focused(&view, cx));
    let request = view.update(cx, |v, _| {
        v.browser_state.create_session = Some(browser::CreateSession {
            phase: browser::CreatePhase::Idle,
            error: None,
            revision: 0,
        });
        v.browser_request
    });
    cx.update(|window, cx| view.update(cx, |v, cx| v.open_new_session(request, window, cx)));
    assert!(!shown(cx), "the welcome stepped aside");
    assert!(view.read_with(cx, |v, _| v.new_session.is_some()));
    cx.simulate_input("api-2");
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(view.read_with(cx, |v, _| v.new_session.is_none()));
    assert!(!view.read_with(cx, |v, _| v.welcome.open));
}
