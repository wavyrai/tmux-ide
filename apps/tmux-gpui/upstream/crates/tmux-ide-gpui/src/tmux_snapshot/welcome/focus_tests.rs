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

/// While setup runs, the primary ("Setting up…") is disabled: no key and no
/// click can ask for setup a second time.
#[gpui::test]
fn a_running_setup_cannot_be_asked_for_again(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Running), &[], fresh(&dir));
    assert!(shown(cx));
    // The disabled primary is never a keyboard stop, however Tab goes.
    for keys in [
        "enter",
        "space",
        "tab",
        "tab",
        "tab",
        "shift-tab",
        "shift-tab",
        "cmd-enter",
        "enter",
    ] {
        cx.simulate_keystrokes(keys);
        draw(cx);
        assert!(!primary_focused(&view, cx), "{keys}");
    }
    for button in ["welcome-button-0", "welcome-button-1"] {
        if let Some(bounds) = cx.debug_bounds(button) {
            cx.simulate_click(bounds.center(), Modifiers::default());
            draw(cx);
        }
    }
    assert!(no_setup(&rx), "no second LocalSetup");
    let _ = view;
}

/// Commands → Welcome from a terminal goes to Home, where the welcome is.
#[gpui::test]
fn opening_the_welcome_from_a_terminal_goes_home(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, None, &[("api", "api")], fresh(&dir));
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            v.browser_state.surface = browser::Surface::Workspace
        })
    });
    draw(cx);
    rx.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |v, cx| v.open_welcome(window, cx)));
    assert!(view.read_with(cx, |v, _| v.welcome.open));
    assert!(
        rx.try_iter()
            .any(|c| matches!(c, browser::Command::Home { .. })),
        "it asks for Home"
    );
}

/// VoiceOver reads each checklist line's detail, the part that says what to
/// do, not only its title and status.
#[gpui::test]
fn checklist_details_are_read_out(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, Some(Phase::Missing), &[], fresh(&dir));
    assert!(shown(cx));
    let detailed = view.read_with(cx, |v, cx| {
        lines(stage(&v.browser_state, true), v.welcome_elapsed(cx), None)
            .iter()
            .filter_map(|line| line.detail.clone())
            .count()
    });
    assert!(detailed > 0, "the fixture has a line with a detail");
    let source = include_str!("render.rs");
    assert!(
        source.contains("row.aria_description(detail)"),
        "each checklist row carries its detail as its accessibility description"
    );
}

/// Closing the welcome also counts this version's What's new as seen: a new
/// user who just closed the welcome does not get the card straight away.
#[gpui::test]
fn closing_the_welcome_remembers_this_versions_whats_new(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (_view, cx, _rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    let skip = cx.debug_bounds("welcome-skip").unwrap();
    cx.simulate_click(skip.center(), Modifiers::default());
    assert!(!shown(cx));
    assert!(
        cx.debug_bounds("whats-new").is_none(),
        "no card right after"
    );
    assert_eq!(whats_new_seen(&dir, cx).as_deref(), Some("0.1.17"));
}

/// The deadline line allows half a second under the 20 s deadline, no more.
#[test]
fn the_deadline_line_starts_half_a_second_before_twenty_seconds() {
    let detail = |ran: Duration| {
        lines(Stage::Setup(Phase::StoppedWaiting), None, Some(ran))[1]
            .detail
            .clone()
    };
    let half = Duration::from_millis(500);
    assert_eq!(detail(SETUP_DEADLINE).as_deref(), Some(FAILED_TIMEOUT));
    assert_eq!(
        detail(SETUP_DEADLINE - half).as_deref(),
        Some(FAILED_TIMEOUT)
    );
    assert_eq!(
        detail(SETUP_DEADLINE - half - Duration::from_millis(1)).as_deref(),
        Some(FAILED_EARLY)
    );
    assert_eq!(
        detail(SETUP_DEADLINE + Duration::from_secs(5)).as_deref(),
        Some(FAILED_TIMEOUT)
    );
}

/// A setup already running when the window first looked: how long it ran is
/// unknown, so when it stops the line claims neither "20 seconds" nor
/// "before it answered".
#[gpui::test]
fn a_run_this_window_did_not_see_start_says_neither(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, Some(Phase::Running), &[], fresh(&dir));
    assert!(shown(cx));
    cx.executor().advance_clock(Duration::from_secs(3));
    draw(cx);
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.local_setup = Some(browser::local_setup::Setup {
                phase: Phase::StoppedWaiting,
            });
            cx.notify();
        })
    });
    draw(cx);
    let line = view.read_with(cx, |v, _| {
        lines(stage(&v.browser_state, true), None, v.welcome.stopped_after)[1].clone()
    });
    assert_eq!(line.detail.as_deref(), Some(FAILED_STOPPED));
}

/// A run the window saw start from Available keeps its measured length.
#[gpui::test]
fn a_run_seen_from_its_start_is_measured(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    let set = |view: &Entity<SnapshotView>, cx: &mut VisualTestContext, phase| {
        cx.update(|_, cx| {
            view.update(cx, |v, cx| {
                v.browser_state.local_setup = Some(browser::local_setup::Setup { phase });
                cx.notify();
            })
        });
        draw(cx);
    };
    set(&view, cx, Phase::Running);
    cx.executor().advance_clock(Duration::from_secs(4));
    set(&view, cx, Phase::StoppedWaiting);
    let line = view.read_with(cx, |v, _| {
        lines(stage(&v.browser_state, true), None, v.welcome.stopped_after)[1].clone()
    });
    assert_eq!(line.detail.as_deref(), Some(FAILED_EARLY));
}

/// What's new is keyed by the bundle's exact version. The newest entry must
/// be at least the version the public installer ships, so a release cut
/// without notes (or with a key in another format) fails here instead of
/// silently showing no card.
#[test]
fn the_newest_notes_are_not_older_than_the_shipped_app() {
    let installer = include_str!("../../../../../../../../docs/public/install-native-alpha.sh");
    let shipped = installer
        .split("tmux-ide-gpui-")
        .nth(1)
        .and_then(|rest| rest.split("-macos-arm64").next());
    // The installer names its app archive.
    let shipped = shipped.unwrap();
    let parse = |v: &str| -> Vec<u32> { v.split('.').map(|n| n.parse().unwrap()).collect() };
    let newest = whats_new::RELEASES[0].0;
    assert_eq!(parse(newest).len(), 3, "a plain x.y.z key: {newest}");
    assert_eq!(parse(shipped).len(), 3, "{shipped}");
    assert!(
        parse(newest) >= parse(shipped),
        "What's new ends at {newest}, but the installer ships {shipped}"
    );
    assert!(whats_new::notes(newest).is_some());
}

/// Each session's Open button is a keyboard stop, before the footer's
/// buttons as on screen, and Return on one opens that session.
#[gpui::test]
fn tab_reaches_each_sessions_open_button(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, None, &[("api", "api"), ("notes", "notes")], fresh(&dir));
    cx.update(|window, cx| view.update(cx, |v, cx| v.open_welcome(window, cx)));
    draw(cx);
    assert!(cx.debug_bounds("welcome-session-1").is_some());
    while rx.try_recv().is_ok() {}
    let focused = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            view.read_with(cx, |v, _| {
                v.welcome.focus.iter().position(|f| f.is_focused(window))
            })
        })
    };
    let start = focused(cx).unwrap();
    assert!(start < 3, "focus starts on a footer button: {start}");
    let mut seen = Vec::new();
    for _ in 0..8 {
        press(cx, "tab", false);
        seen.push(focused(cx).unwrap());
    }
    assert!(seen.contains(&3) && seen.contains(&4), "{seen:?}");
    let first = seen.iter().position(|&i| i == 3).unwrap();
    assert_eq!(seen[first + 1], 4, "the rows in order: {seen:?}");
    assert!(seen[first + 2] < 3, "then the footer: {seen:?}");
    // Return on the second row's Open opens that session.
    while focused(cx) != Some(4) {
        press(cx, "tab", false);
    }
    assert!(rx.try_recv().is_err());
    press(cx, "enter", false);
    assert!(
        rx.try_iter().next().is_some(),
        "Return on Open sends the open"
    );
}

/// A focused Open button whose row goes away (its session ended, or the
/// list was lost) does not keep the keyboard on nothing: the welcome's
/// start button takes it, and Tab and Return work again.
#[gpui::test]
fn a_focused_open_button_that_disappears_hands_the_keyboard_on(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, None, &[("api", "api"), ("notes", "notes")], fresh(&dir));
    cx.update(|window, cx| view.update(cx, |v, cx| v.open_welcome(window, cx)));
    draw(cx);
    let focused = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| {
            view.read_with(cx, |v, _| {
                v.welcome.focus.iter().position(|f| f.is_focused(window))
            })
        })
    };
    // The second row goes, then the first: each time its Open had the keyboard.
    for gone in [1usize, 0] {
        for _ in 0..8 {
            if focused(cx) == Some(3 + gone) {
                break;
            }
            press(cx, "tab", false);
        }
        assert_eq!(focused(cx), Some(3 + gone), "fixture: on row {gone}'s Open");
        cx.update(|_, cx| {
            view.update(cx, |v, cx| {
                v.browser_state.sessions.truncate(gone);
                cx.notify();
            })
        });
        draw(cx);
        assert!(shown(cx), "the welcome stays open");
        let at = focused(cx);
        assert!(
            at.is_some_and(|stop| stop < 3 + gone),
            "the keyboard is on a button that is on screen: {at:?}"
        );
        press(cx, "tab", false);
        assert_ne!(focused(cx), at, "Tab moves again");
    }
    let _ = rx;
}
