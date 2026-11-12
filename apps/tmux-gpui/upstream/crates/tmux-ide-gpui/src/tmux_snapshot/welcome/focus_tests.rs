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

fn press(cx: &mut VisualTestContext, key: &str, is_held: bool) {
    cx.simulate_event(KeyDownEvent {
        keystroke: Keystroke::parse(key).unwrap(),
        is_held,
        prefer_character_input: false,
        layout: None,
    });
    draw(cx);
}

/// The welcome's keys are plain ones: with Command, Control or Option held,
/// or a key held down, nothing is pressed and focus stays.
#[gpui::test]
fn the_welcome_ignores_modified_and_held_keys(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    for key in [
        "cmd-enter",
        "ctrl-enter",
        "alt-enter",
        "cmd-tab",
        "ctrl-tab",
        "alt-tab",
    ] {
        press(cx, key, false);
        assert!(primary_focused(&view, cx), "{key}");
    }
    press(cx, "enter", true);
    press(cx, "tab", true);
    assert!(primary_focused(&view, cx), "held");
    assert!(no_setup(&rx));
    assert!(shown(cx));
}

/// The welcome answers each key once: one Tab moves one stop, which it
/// would not if Tab also reached Home's own keyboard order.
#[gpui::test]
fn one_tab_on_the_welcome_moves_one_stop(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Missing), &[], fresh(&dir));
    assert!(shown(cx));
    let focused = |cx: &mut VisualTestContext, i: usize| {
        cx.update(|window, cx| view.read_with(cx, |v, _| v.welcome.focus[i].is_focused(window)))
    };
    for expected in [2, 0, 1, 2] {
        press(cx, "tab", false);
        assert!(focused(cx, expected), "Tab to {expected}");
    }
    press(cx, "shift-tab", false);
    assert!(focused(cx, 1));
    assert!(no_setup(&rx));
}

#[test]
fn notes_are_for_exactly_one_version() {
    assert!(whats_new::notes("0.1.17").is_some());
    for version in ["0.1.1", "0.1.170", "0.1.17.1", "0.1", "", "Earlier"] {
        assert_eq!(whats_new::notes(version), None, "{version}");
    }
}

fn whats_new_home<'a>(
    cx: &'a mut TestAppContext,
    dir: &tempfile::TempDir,
) -> (Entity<SnapshotView>, &'a mut VisualTestContext) {
    std::fs::write(
        dir.path().join("gpui-onboarding.json"),
        r#"{"version":1,"welcomed":true,"whats_new_seen":"0.1.16"}"#,
    )
    .unwrap();
    let (view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(dir));
    draw(cx);
    assert!(cx.debug_bounds("whats-new").is_some());
    (view, cx)
}

/// Tab reaches the What's new card's See everything and Close after Home's
/// own stops; Return on Close closes it and remembers it.
#[gpui::test]
fn tab_reaches_the_whats_new_buttons_and_return_presses_them(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx) = whats_new_home(cx, &dir);
    let on = |cx: &mut VisualTestContext, i: usize| {
        cx.update(|window, cx| {
            view.read_with(cx, |v, _| v.welcome.whats_new_focus[i].is_focused(window))
        })
    };
    press(cx, "shift-tab", false);
    assert!(
        on(cx, 1),
        "Shift-Tab from Home goes to Close, the last stop"
    );
    press(cx, "shift-tab", false);
    assert!(on(cx, 0), "then See everything");
    press(cx, "tab", false);
    assert!(on(cx, 1));
    // GPUI presses a focused button on the key's release.
    cx.simulate_keystrokes("enter");
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    draw(cx);
    assert!(cx.debug_bounds("whats-new").is_none());
    let terminal = view.read_with(cx, |v, _| v.terminal_focus.clone());
    cx.update(|window, _| assert!(terminal.is_focused(window)));
    assert_eq!(
        whats_new_seen(&dir, cx).as_deref(),
        Some("0.1.17"),
        "remembered"
    );
}

/// Escape closes the card, from the card or from Home.
#[gpui::test]
fn escape_closes_whats_new(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx) = whats_new_home(cx, &dir);
    press(cx, "shift-tab", false);
    press(cx, "escape", false);
    assert!(cx.debug_bounds("whats-new").is_none(), "from the card");
    let dir = tempfile::tempdir().unwrap();
    cx.update(|_, cx| {
        std::fs::write(
            dir.path().join("gpui-onboarding.json"),
            r#"{"version":1,"welcomed":true,"whats_new_seen":"0.1.16"}"#,
        )
        .unwrap();
        view.update(cx, |v, _| v.welcome = fresh(&dir));
    });
    draw(cx);
    assert!(cx.debug_bounds("whats-new").is_some());
    let terminal = view.read_with(cx, |v, _| v.terminal_focus.clone());
    cx.update(|window, cx| terminal.focus(window, cx));
    press(cx, "escape", false);
    assert!(cx.debug_bounds("whats-new").is_none(), "from Home");
}

fn whats_new_seen(dir: &tempfile::TempDir, cx: &mut VisualTestContext) -> Option<String> {
    cx.run_until_parked();
    fresh(dir).whats_new_seen
}

/// A key the welcome answers ends there: Tab and Space do not go on to the
/// window's own key handling under it.
#[gpui::test]
fn the_welcomes_keys_end_at_the_welcome(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (_view, cx, _rx) = home(cx, Some(Phase::Missing), &[], fresh(&dir));
    assert!(shown(cx));
    for key in ["tab", "shift-tab"] {
        let result = cx.update(|window, cx| {
            window.dispatch_event(
                PlatformInput::KeyDown(KeyDownEvent {
                    keystroke: Keystroke::parse(key).unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                    layout: None,
                }),
                cx,
            )
        });
        assert!(!result.propagate, "{key}");
        assert!(result.default_prevented, "{key}");
        draw(cx);
    }
}
