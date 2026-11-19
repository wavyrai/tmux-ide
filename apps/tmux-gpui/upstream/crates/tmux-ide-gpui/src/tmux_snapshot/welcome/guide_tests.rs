//! The setup guide (onboarding phase 1): its steps, rail and footer, the
//! Look and Keys steps, Esc, and what is saved as it goes.
#![allow(clippy::unwrap_used)]
use super::guide::{Act as G, Filter, Step, on_filter, slot};
use super::tests::{draw, fresh, home, shown};
use super::*;
use crate::tmux_snapshot::appearance::{System, native::Owner};
use core::prelude::v1::test;
use std::sync::mpsc::Receiver;

fn saved(dir: &tempfile::TempDir, cx: &mut VisualTestContext) -> State {
    cx.run_until_parked();
    fresh(dir)
}
fn act(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, act: G) {
    cx.update(|window, cx| view.update(cx, |v, cx| v.guide_act(act, window, cx)));
    draw(cx);
}
fn click(cx: &mut VisualTestContext, selector: &str) {
    let selector: &'static str = Box::leak(selector.to_string().into_boxed_str());
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(bounds.center(), Modifiers::default());
    draw(cx);
}
fn focused(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, slot: usize) -> bool {
    cx.update(|window, cx| view.read_with(cx, |v, _| v.welcome.focus[slot].is_focused(window)))
}
fn step(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> Step {
    view.read_with(cx, |v, _| v.welcome.guide.step)
}
/// The theme commands sent so far: an id, or "light:" / "dark:" and the id
/// for one side of Match macOS.
fn themes(rx: &Receiver<browser::Command>) -> Vec<String> {
    rx.try_iter()
        .filter_map(|c| match c {
            browser::Command::Theme { id } => Some(id),
            browser::Command::ThemeFor { side, id } => Some(format!(
                "{}:{id}",
                if side == System::Light {
                    "light"
                } else {
                    "dark"
                }
            )),
            _ => None,
        })
        .collect()
}
fn theme(id: &str) -> String {
    id.into()
}
/// A new user's guide on a live Home, with the generated themes published
/// and `selected` in use; at Look.
fn at_look<'a>(
    cx: &'a mut TestAppContext,
    dir: &tempfile::TempDir,
    selected: &str,
) -> (
    Entity<SnapshotView>,
    &'a mut VisualTestContext,
    Receiver<browser::Command>,
) {
    let (view, cx, rx) = home(cx, None, &[("api", "api")], fresh(dir));
    let mut appearance = Owner::load(None).unwrap().publication();
    appearance.selected = selected.into();
    cx.update(|_, cx| view.update(cx, |v, _| v.browser_state.appearance = Some(appearance)));
    act(&view, cx, G::Next);
    assert_eq!(step(&view, cx), Step::Look);
    (view, cx, rx)
}
fn select(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, id: &str) {
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            if let Some(a) = &mut v.browser_state.appearance {
                a.selected = id.into();
            }
            cx.notify();
        })
    });
    draw(cx);
}

#[test]
fn a_segment_keeps_the_theme_in_use_and_comes_back_to_it() {
    let pair = ("paper", "nord");
    let none = [None, None];
    // Already under it: nothing changes.
    assert_eq!(on_filter(Filter::Dark, "tokyo", pair, &none), None);
    assert_eq!(on_filter(Filter::Light, "paper", pair, &none), None);
    assert_eq!(on_filter(Filter::System, "system", pair, &none), None);
    // Otherwise the one last picked there, else Match macOS's side.
    assert_eq!(
        on_filter(Filter::Light, "tokyo", pair, &none).as_deref(),
        Some("paper")
    );
    let picked = [Some("github-light".into()), Some("tokyo".into())];
    assert_eq!(
        on_filter(Filter::Light, "tokyo", pair, &picked).as_deref(),
        Some("github-light")
    );
    assert_eq!(
        on_filter(Filter::Dark, "github-light", pair, &picked).as_deref(),
        Some("tokyo")
    );
    assert_eq!(
        on_filter(Filter::System, "tokyo", pair, &none).as_deref(),
        Some("system")
    );
}

/// Dark → Light → Dark in the guide comes back to the theme in use.
#[gpui::test]
fn dark_light_dark_returns_to_your_theme(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = at_look(cx, &dir, "tokyo");
    assert!(cx.debug_bounds("welcome-themes").is_some(), "Dark's tiles");
    click(cx, "welcome-filter-2");
    assert!(themes(&rx).is_empty(), "already under Dark");
    click(cx, "welcome-filter-1");
    assert_eq!(themes(&rx), [theme("linen")], "Match macOS's light side");
    select(&view, cx, "linen");
    click(cx, "welcome-filter-2");
    assert_eq!(themes(&rx), [theme("tokyo")]);
}

#[gpui::test]
fn a_tile_and_the_arrows_apply_a_theme_and_match_macos_picks_each_side(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = at_look(cx, &dir, "tokyo");
    let darks = guide::themes(Filter::Dark);
    let nord = darks.iter().position(|p| p.id == "nord").unwrap();
    click(cx, &format!("welcome-theme-{nord}"));
    assert_eq!(themes(&rx), [theme("nord")]);
    // The keyboard: Tab from the segment reaches the grid, on the theme in
    // use; Right picks the next one.
    let tokyo = darks.iter().position(|p| p.id == "tokyo").unwrap();
    assert!(
        focused(&view, cx, slot::SEGMENT),
        "Look starts on the segment"
    );
    cx.simulate_keystrokes("tab");
    assert!(focused(&view, cx, slot::GRID));
    cx.simulate_keystrokes("right");
    let next = &darks[(tokyo + 1).min(darks.len() - 1)].id;
    assert_eq!(themes(&rx), [theme(next)]);
    // Match macOS: one row for each side.
    select(&view, cx, "system");
    assert!(cx.debug_bounds("welcome-themes").is_none());
    click(cx, &format!("welcome-dark-{nord}"));
    let lights = guide::themes(Filter::Light);
    let paper = lights.iter().position(|p| p.id == "paper").unwrap();
    click(cx, &format!("welcome-light-{paper}"));
    assert_eq!(themes(&rx), ["dark:nord", "light:paper"]);
}

#[gpui::test]
fn without_appearance_look_says_so_and_still_offers_the_rest(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(&dir));
    act(&view, cx, G::Next);
    assert!(cx.debug_bounds("welcome-look-unavailable").is_some());
    assert!(cx.debug_bounds("welcome-filter").is_none());
    assert!(cx.debug_bounds("welcome-font-size").is_some());
    let opaque: &'static str =
        Box::leak(format!("welcome-switch-{}", slot::OPAQUE).into_boxed_str());
    assert!(cx.debug_bounds(opaque).is_some());
}

/// "Opaque window" is saved, and a frosted window goes opaque with it.
#[gpui::test]
fn opaque_window_is_saved_and_turns_the_glass_off(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = at_look(cx, &dir, "tokyo");
    let path = dir.path().join("gpui-opaque.json");
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            v.chrome.opaque = crate::tmux_snapshot::opaque_window::for_test(Some(path.clone()));
            v.chrome.force(true);
        })
    });
    draw(cx);
    assert!(cx.update(|_, cx| view.update(cx, |v, _| v.chrome.refresh())));
    click(cx, &format!("welcome-switch-{}", slot::OPAQUE));
    cx.run_until_parked();
    assert!(view.read_with(cx, |v, _| v.chrome.opaque.enabled));
    assert!(
        crate::tmux_snapshot::developer_mode::read(&path)
            .unwrap()
            .enabled
    );
    assert!(
        !cx.update(|_, cx| view.update(cx, |v, _| v.chrome.refresh())),
        "no glass"
    );
    // A save that fails keeps the saved value and says so.
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    click(cx, &format!("welcome-switch-{}", slot::OPAQUE));
    cx.run_until_parked();
    draw(cx);
    view.read_with(cx, |v, _| {
        assert!(v.chrome.opaque.enabled);
        assert_eq!(
            v.chrome.opaque.note,
            Some(crate::tmux_snapshot::opaque_window::SAVE_FAILED)
        );
    });
    assert!(cx.debug_bounds("welcome-look-warning").is_some());
}

#[gpui::test]
fn cursor_animation_is_saved_from_look(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = at_look(cx, &dir, "tokyo");
    let path = dir.path().join("gpui-cursor.json");
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            v.cursor_motion = crate::tmux_snapshot::cursor_motion::Setting::load(Some(path.clone()))
        })
    });
    draw(cx);
    // Space flips a switch with the keyboard on it.
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.welcome.focus[slot::CURSOR].clone().focus(window, cx)
        })
    });
    cx.simulate_keystrokes("space");
    cx.run_until_parked();
    assert!(!view.read_with(cx, |v, _| v.cursor_motion.enabled));
    assert!(
        !crate::tmux_snapshot::developer_mode::read(&path)
            .unwrap()
            .enabled
    );
    assert_eq!(step(&view, cx), Step::Look, "Space never means Continue");
}

/// While the Keys step has the keyboard, a key it lists ticks its row and
/// does nothing else; every other key goes on as usual.
#[gpui::test]
fn the_keys_step_ticks_a_listed_key_instead_of_running_it(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(&dir));
    act(&view, cx, G::Next);
    act(&view, cx, G::Next);
    assert_eq!(step(&view, cx), Step::Keys);
    assert!(focused(&view, cx, slot::NEXT), "Start using comes first");
    let hidden = view.read_with(cx, |v, _| v.sidebar_hidden);
    for (key, row) in [("f5", 0), ("cmd-k", 1), ("cmd-shift-d", 4), ("f10", 7)] {
        cx.simulate_keystrokes(key);
        draw(cx);
        view.read_with(cx, |v, _| {
            assert!(v.welcome.guide.tried[row], "{key}");
            assert!(v.picker.is_none(), "{key} opened nothing");
            assert_eq!(v.sidebar_hidden, hidden, "{key} left the sidebar");
        });
    }
    let tried = view.read_with(cx, |v, _| v.welcome.guide.tried);
    assert_eq!(tried.iter().filter(|t| **t).count(), 4);
    // A click ticks a row too.
    click(cx, "welcome-key-2");
    assert!(view.read_with(cx, |v, _| v.welcome.guide.tried[2]));
    assert!(shown(cx));
}

#[gpui::test]
fn esc_closes_the_guide_at_every_step_and_remembers_how_far(cx: &mut TestAppContext) {
    for (nexts, reached) in [(0, 1), (1, 3), (2, 5)] {
        let dir = tempfile::tempdir().unwrap();
        let (view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(&dir));
        for _ in 0..nexts {
            act(&view, cx, G::Next);
        }
        cx.simulate_keystrokes("escape");
        assert!(!shown(cx), "Esc at step {nexts}");
        let state = saved(&dir, cx);
        assert!(state.welcomed);
        assert_eq!(state.guide.reached, reached);
        assert!(!state.guide.finished);
    }
}

#[gpui::test]
fn the_rail_opens_only_steps_reached_and_back_returns(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, Some(Phase::Available), &[], fresh(&dir));
    assert!(shown(cx));
    // Setup isn't done: Continue can't be pressed or reached.
    click(cx, "welcome-next");
    assert_eq!(step(&view, cx), Step::SetUp);
    click(cx, "welcome-rail-2");
    assert_eq!(step(&view, cx), Step::SetUp, "Keys not reached yet");
    // Set up: Continue to Look, saved as reached.
    tests::publish(&view, cx, None);
    click(cx, "welcome-next");
    assert_eq!(step(&view, cx), Step::Look);
    assert_eq!(saved(&dir, cx).guide.reached, 3);
    click(cx, "welcome-back");
    assert_eq!(step(&view, cx), Step::SetUp);
    click(cx, "welcome-rail-1");
    assert_eq!(step(&view, cx), Step::Look, "a reached step opens");
    // Return on the segment (not a button) is Continue.
    assert!(cx.debug_bounds("welcome-back").is_some());
    cx.simulate_keystrokes("enter");
    assert_eq!(step(&view, cx), Step::Keys);
}

/// Start using with setup skipped goes back to Home and opens nothing.
#[gpui::test]
fn start_using_without_setup_closes_to_home(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, rx) = home(cx, Some(Phase::Missing), &[], fresh(&dir));
    click(cx, "welcome-skip");
    assert_eq!(step(&view, cx), Step::Look, "Continue without it");
    act(&view, cx, G::Next);
    click(cx, "welcome-next");
    assert!(!shown(cx));
    assert!(view.read_with(cx, |v, _| v.new_session.is_none()));
    assert!(
        rx.try_iter()
            .all(|c| !matches!(c, browser::Command::Session { .. }))
    );
    let state = saved(&dir, cx);
    assert!(state.welcomed && state.guide.finished && state.guide.setup_skipped);
}

/// VoiceOver: the card is a region named by its step, the rail a list of
/// steps that say where they are, Look's controls radio groups and switches,
/// and the preview one labelled image.
#[gpui::test]
fn voiceover_reads_the_guide(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (_view, cx, _rx) = at_look(cx, &dir, "tokyo");
    cx.update(|window, cx| {
        window.set_a11y_active_for_test(true);
        window.draw(cx).clear(cx);
    });
    let json = cx.update(|window, _| window.debug_a11y_tree_json().unwrap());
    let tree: serde_json::Value = serde_json::from_str(&json).unwrap();
    let nodes: Vec<(String, String)> = tree["nodes"]
        .as_object()
        .unwrap()
        .values()
        .map(|n| {
            (
                n["aria"]["role"].as_str().unwrap_or_default().to_string(),
                n["aria"]["label"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    for (role, label) in [
        ("Region", render::LOOK_TITLE),
        ("List", "Setup steps"),
        ("Button", "Step 1 of 3, Set up, visited"),
        ("Button", "Step 2 of 3, Look, current"),
        ("Button", "Step 3 of 3, Keys, not reached yet"),
        ("RadioGroup", "Appearance"),
        ("RadioButton", "Match macOS"),
        ("RadioGroup", "Theme"),
        ("RadioButton", "Tokyo Night, dark"),
        ("Image", "Preview of Tokyo Night"),
        ("Switch", "Cursor animation"),
        ("Switch", "Opaque window"),
        ("Button", "Continue"),
        ("Button", "Back"),
        ("Button", "Skip setup"),
    ] {
        assert!(
            nodes.iter().any(|(r, l)| r == role && l == label),
            "{role} {label:?} in {nodes:#?}"
        );
    }
}

/// Commands → Welcome to Tmux IDE… starts at Set up with every step open,
/// whether the guide was closed further on or is still open at a later step.
#[gpui::test]
fn reopening_from_commands_starts_at_set_up_with_every_step_open(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (view, cx, _rx) = home(cx, None, &[("api", "api")], fresh(&dir));
    act(&view, cx, G::Next);
    assert_eq!(step(&view, cx), Step::Look);
    cx.simulate_keystrokes("escape");
    assert!(!shown(cx));
    let reopen = |view: &Entity<SnapshotView>, cx: &mut VisualTestContext| {
        cx.update(|window, cx| view.update(cx, |v, cx| v.open_welcome(window, cx)));
        draw(cx);
        assert!(shown(cx));
        assert_eq!(step(view, cx), Step::SetUp);
        view.read_with(cx, |v, _| {
            for s in Step::ALL {
                assert!(v.welcome.guide.enabled(s), "{s:?}");
            }
        });
    };
    reopen(&view, cx);
    // Still open at Keys: Commands brings it back to the first step.
    act(&view, cx, G::Next);
    act(&view, cx, G::Next);
    assert_eq!(step(&view, cx), Step::Keys);
    reopen(&view, cx);
    assert!(
        focused(&view, cx, slot::NEXT),
        "set up: Continue has the keyboard"
    );
}
