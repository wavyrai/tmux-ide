#![allow(clippy::unwrap_used)]
//! The workspace shell on Bezel: session list, status bar, empty pane.
use super::*;
use crate::tmux_snapshot::design::{self, InkProbes};
use core::prelude::v1::test;
use std::sync::mpsc;

fn choice(id: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: format!("Session {id}"),
        pane_count: None,
        window_id: None,
        browser_icon: None,
        window_label: None,
    }
}

fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
    sessions: usize,
) -> SnapshotView {
    crate::tmux_snapshot::fit_test_support::fixture_view(
        window,
        cx,
        sender,
        7,
        browser::State {
            request: 7,
            surface: browser::Surface::Workspace,
            input_ready: true,
            sessions: (0..sessions).map(|i| choice(&format!("s{i}"))).collect(),
            panes: vec![choice("pane-a")],
            selected_session: Some("s1".into()),
            ..Default::default()
        },
    )
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

fn row_bounds(cx: &mut VisualTestContext) -> Vec<Bounds<Pixels>> {
    [
        "tmux-sidebar-row-0",
        "tmux-sidebar-row-1",
        "tmux-sidebar-row-2",
        "tmux-sidebar-row-3",
        "tmux-sidebar-row-4",
    ]
    .into_iter()
    .map(|row| cx.debug_bounds(row).unwrap())
    .collect()
}

/// The keyboard-selected row used to gain a border while focused, growing by
/// a pixel each side and pushing every row under it down. The ring now lies
/// over the focused row and nowhere else.
#[gpui::test]
fn keyboard_focus_moves_no_row(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender, 5));
    cx.simulate_resize(size(px(800.), px(600.)));
    draw(cx);
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let resting = row_bounds(cx);
    assert!(
        resting.iter().all(|row| row.size.height == px(29.5)),
        "{resting:?}"
    );
    assert!(cx.debug_bounds("tmux-sidebar-focus-ring").is_none());
    cx.simulate_keystrokes("ctrl-g");
    draw(cx);
    view.read_with(cx, |view, _| {
        assert!(view.sidebar_keyboard.active);
        assert!(view.sidebar_keyboard.selected.is_some());
    });
    assert_eq!(row_bounds(cx), resting);
    let ring = cx.debug_bounds("tmux-sidebar-focus-ring").unwrap();
    let focused = resting.iter().position(|row| *row == ring);
    assert!(
        focused.is_some(),
        "the ring covers one row exactly: {ring:?}"
    );
    cx.simulate_keystrokes("down");
    draw(cx);
    assert_eq!(row_bounds(cx), resting);
    let moved = cx.debug_bounds("tmux-sidebar-focus-ring").unwrap();
    assert_eq!(Some(moved), focused.map(|index| resting[index + 1]));
}

#[gpui::test]
fn the_focused_row_alone_shows_the_ring(cx: &mut TestAppContext) {
    cx.update(|cx| {
        design::prepare(&crate::config::Theme::default(), false, cx);
        let bezel = bezel_theme::Theme::of(cx).clone();
        let mut ring = ring(&bezel);
        let style = ring.style();
        assert_eq!(style.border_color, Some(bezel.ring));
        assert_eq!(style.position, Some(Position::Absolute));
        let width = Some(AbsoluteLength::Pixels(px(1.)));
        assert_eq!(style.border_widths.top, width);
        assert_eq!(style.border_widths.bottom, width);
        assert_eq!(style.border_widths.left, width);
        assert_eq!(style.border_widths.right, width);
        let radius = Some(AbsoluteLength::Pixels(px(
            bezel_theme::Theme::control_radius(),
        )));
        assert_eq!(style.corner_radii.top_left, radius);
        // The row itself draws no border, focused or not.
        for focused in [true, false] {
            let mut row = focus_ring(div().id("row"), focused, &bezel);
            assert_eq!(row.style().border_widths.top, None);
        }
    });
}

#[gpui::test]
fn keyboard_reveal_scrolls_the_session_list_beside_its_bar(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender, 40));
    cx.simulate_resize(size(px(640.), px(400.)));
    draw(cx);
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.simulate_keystrokes("ctrl-g end");
    draw(cx);
    draw(cx);
    let offset = view.read_with(cx, |view, _| view.sidebar_keyboard.scroll.offset());
    assert!(offset.y < px(0.), "End scrolled the list: {offset:?}");
    let list = cx.debug_bounds("session-list").unwrap();
    let last = cx.debug_bounds("tmux-sidebar-row-39").unwrap();
    assert!(last.top() >= list.top() && last.bottom() <= list.bottom());
    let track = cx.debug_bounds("session-list-track");
    assert!(
        track.is_some(),
        "an overflowing session list shows Bezel's scrollbar"
    );
    let track = track.unwrap();
    assert_eq!(track.right(), list.right());
    // The bar's strip covers only the rows' trailing padding.
    let label = cx.debug_bounds("tmux-sidebar-label-39").unwrap();
    assert!(label.right() <= track.left(), "{label:?} under {track:?}");
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn a_long_developer_status_scrolls_under_bezels_bar(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender, 2));
    cx.simulate_resize(size(px(800.), px(600.)));
    view.update(cx, |view, _| {
        view.developer_mode.enabled = true;
        view.browser_state.status =
            "Reconnecting to the tmux server after a dropped link. ".repeat(20);
    });
    draw(cx);
    draw(cx);
    receiver.try_iter().for_each(drop);
    let lane = cx.debug_bounds("tmux-status-viewport").unwrap();
    assert!(lane.size.height <= px(72.), "{lane:?}");
    let track = cx.debug_bounds("connection-status-track");
    assert!(
        track.is_some(),
        "an overflowing status lane shows Bezel's scrollbar"
    );
    let track = track.unwrap();
    assert_eq!(track.right(), lane.right());
}

#[gpui::test]
fn the_empty_pane_shows_bezels_empty_state_on_the_opaque_fill(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender, 2);
        view.frame = None;
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| cx.set_global(InkProbes::default()));
    cx.simulate_resize(size(px(800.), px(600.)));
    draw(cx);
    let fill = cx.debug_bounds("tmux-pane-empty").unwrap();
    let state = cx.debug_bounds("tmux-pane-empty-state").unwrap();
    assert!(state.left() >= fill.left() && state.right() <= fill.right());
    // Icon, title and hint, each on its own line inside Bezel's 40px of air.
    assert!(
        state.size.height > px(80. + 24. + 12. + 2. * 12.),
        "{state:?}"
    );
    let bezel = cx.update(|_, cx| bezel_theme::Theme::of(cx).clone());
    assert_eq!(
        bezel.terminal_bg,
        view.read_with(cx, |v, _| rgb(v.theme().background).into())
    );
    cx.update(|_, cx| {
        assert_eq!(
            cx.global::<InkProbes>().0.get("pane-empty"),
            Some(&bezel.text)
        );
    });
}

#[test]
fn the_home_panel_takes_bezels_panel_corner_and_inset() {
    let mut panel = super::super::shell::content_panel(0x123456, true);
    let style = panel.style();
    let radius = Some(AbsoluteLength::Pixels(px(
        bezel_theme::Theme::panel_radius(),
    )));
    assert_eq!(style.corner_radii.top_left, radius);
    assert_eq!(style.corner_radii.bottom_right, radius);
    let inset = Some(DefiniteLength::Absolute(AbsoluteLength::Pixels(px(
        bezel_theme::Theme::CONTENT_INSET / 2.,
    ))));
    assert_eq!(style.padding.top, inset);
    assert_eq!(style.padding.left, inset);
}

#[derive(serde::Deserialize)]
struct Preset {
    id: String,
    dark: serde_json::Value,
    light: serde_json::Value,
}

fn catalog() -> Vec<(String, serde_json::Value)> {
    let presets: Vec<Preset> =
        serde_json::from_str(include_str!("appearance/catalog.json")).unwrap();
    presets
        .into_iter()
        .flat_map(|preset| {
            [
                (format!("{} (dark)", preset.id), preset.dark),
                (format!("{} (light)", preset.id), preset.light),
            ]
        })
        .collect()
}

fn appearance(colors: &serde_json::Value) -> super::super::appearance::Appearance {
    serde_json::from_value(serde_json::json!({
        "selected":"preset","system":"dark","error":null,"theme":colors,
        "options":[{"id":"preset","name":"Preset"}]
    }))
    .unwrap()
}

/// The window chrome a sidebar or title bar label sits on: the surface and,
/// in a dark theme, its frost over a white and a black desktop.
fn chrome_plates(bezel: &bezel_theme::Theme) -> Vec<(Hsla, &'static str)> {
    let mut plates = vec![(bezel.surface, "surface")];
    if bezel.appearance == bezel_theme::Appearance::Dark {
        plates.push((
            bezel_theme::flatten(bezel.vibrancy_tint(), white()),
            "frost on white",
        ));
        plates.push((
            bezel_theme::flatten(bezel.vibrancy_tint(), black()),
            "frost on black",
        ));
    }
    plates
}

fn check(
    failures: &mut Vec<String>,
    name: &str,
    probes: &InkProbes,
    key: &str,
    plates: &[(Hsla, &'static str)],
) {
    let Some(&text) = probes.0.get(key) else {
        failures.push(format!("{name}: {key} not painted"));
        return;
    };
    for (plate, plate_name) in plates {
        let ratio = bezel_theme::contrast_ratio(bezel_theme::flatten(text, *plate), *plate);
        if ratio < 4.5 {
            failures.push(format!("{name}: {key} on {plate_name} is {ratio:.2}:1"));
        }
    }
}

#[gpui::test]
fn shell_text_reads_on_its_plate_in_every_catalog_theme(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(4096);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender, 3));
    cx.simulate_resize(size(px(1000.), px(700.)));
    let themes = catalog();
    assert_eq!(themes.len(), 50);
    let mut failures = Vec::new();
    for (name, colors) in &themes {
        for developer in [true, false] {
            view.update(cx, |view, _| {
                view.browser_state.appearance = Some(appearance(colors));
                view.browser_state.fleet = Some(
                    serde_json::from_value(serde_json::json!({
                        "preferences":{"revision":1,"phase":"loading","error":null},
                        "omittedGroups":0,"groups":[]
                    }))
                    .unwrap(),
                );
                view.browser_state.status = "Copy failed — try again".into();
                view.developer_mode.enabled = developer;
            });
            cx.update(|_, cx| cx.set_global(InkProbes::default()));
            draw(cx);
            receiver.try_iter().for_each(drop);
            let theme = view.read_with(cx, |view, _| view.theme());
            let bezel = design::palette(&theme);
            let chrome = chrome_plates(&bezel);
            let background = [(bezel.bg, "background")];
            let mut everywhere = chrome.clone();
            everywhere.extend(background);
            let probes = cx.update(|_, cx| std::mem::take(cx.global_mut::<InkProbes>()));
            check(&mut failures, name, &probes, "shell-root", &chrome);
            check(&mut failures, name, &probes, "workspace-body", &everywhere);
            check(&mut failures, name, &probes, "sidebar-heading", &chrome);
            check(&mut failures, name, &probes, "sidebar-status", &chrome);
            if developer {
                // The developer lane is opaque, on the terminal's background.
                check(&mut failures, name, &probes, "status-text", &background);
                check(&mut failures, name, &probes, "status-title", &background);
                // Bezel's status bar ink, not a colour set over it.
                for key in ["status-text", "status-title"] {
                    if probes.0.get(key) != Some(&bezel.text_muted) {
                        failures.push(format!("{name}: {key} is not the bar's text_muted"));
                    }
                }
            } else {
                // The notice sits in the title bar, on the chrome.
                check(&mut failures, name, &probes, "status-text", &chrome);
            }
        }
        // The empty pane's title and hint, on the opaque terminal fill.
        let theme = view.read_with(cx, |view, _| view.theme());
        let ink = design::palette(&theme);
        let plate = ink.terminal_bg;
        for (role, text) in [("title", ink.text), ("hint", ink.text_muted)] {
            let ratio = bezel_theme::contrast_ratio(bezel_theme::flatten(text, plate), plate);
            if ratio < 4.5 {
                failures.push(format!("{name}: empty pane {role} is {ratio:.2}:1"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
