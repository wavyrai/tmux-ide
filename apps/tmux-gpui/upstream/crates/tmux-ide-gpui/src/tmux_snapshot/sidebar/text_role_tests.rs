#![allow(clippy::unwrap_used)]
//! The sidebar row's text on Bezel's type ladder: the geometry it lays out
//! and the ink every role paints.
use super::*;
use crate::tmux_snapshot::{
    appearance::{Appearance, Colors, System},
    design::{InkProbes, palette, row_ink},
};
use core::prelude::v1::test;
use gpui::{Hsla, TestAppContext};

#[derive(serde::Deserialize)]
struct Preset {
    id: String,
    dark: Colors,
    light: Colors,
}

/// Every catalog preset in both variants, as the appearance the daemon
/// publishes for it.
pub(super) fn catalog() -> Vec<(String, Appearance)> {
    let presets: Vec<Preset> =
        serde_json::from_str(include_str!("../appearance/catalog.json")).unwrap();
    let variants: Vec<_> = presets
        .into_iter()
        .flat_map(|preset| {
            [
                (format!("{} (dark)", preset.id), System::Dark, preset.dark),
                (
                    format!("{} (light)", preset.id),
                    System::Light,
                    preset.light,
                ),
            ]
        })
        .map(|(name, system, theme)| {
            let appearance = Appearance {
                selected: "theme".into(),
                system,
                theme,
                options: Vec::new(),
                error: None,
            };
            (name, appearance)
        })
        .collect();
    assert_eq!(variants.len(), 50, "25 presets, two variants each");
    variants
}

/// The frosted sidebar under text: the opaque surface and, where Bezel
/// frosts (dark), the frost over a white and over a black desktop; with
/// `washes`, also a row's selected and hover fills on each.
pub(super) fn plates(theme: &Theme, washes: bool) -> Vec<Hsla> {
    let bezel = palette(theme);
    let mut bare = vec![Hsla::from(rgb(theme.surface))];
    if bezel.appearance == bezel_theme::Appearance::Dark {
        for desktop in [white(), black()] {
            bare.push(bezel_theme::flatten(bezel.vibrancy_tint(), desktop));
        }
    }
    bare.into_iter()
        .flat_map(|plate| {
            let mut under = vec![plate];
            if washes {
                under.push(bezel_theme::flatten(bezel.card_selected_bg(), plate));
                under.push(bezel_theme::flatten(bezel.element_hover, plate));
            }
            under
        })
        .collect()
}

/// The lowest contrast `text` reaches on `plates`.
pub(super) fn worst(text: Hsla, plates: &[Hsla]) -> f32 {
    plates
        .iter()
        .map(|plate| bezel_theme::contrast_ratio(text, *plate))
        .fold(f32::INFINITY, f32::min)
}

fn row(session: bool, count: bool, summary: Option<&str>) -> Row {
    Row {
        label: "tmux-ide".into(),
        pane_count: count.then(|| "2 panes".into()),
        selected: false,
        target: Some(if session {
            Target::Session("tmux-ide".into())
        } else {
            Target::Collapse {
                machine: "m".into(),
                revision: 1,
                action: "a".into(),
                enabled: true,
            }
        }),
        depth: u8::from(!session),
        machine: None,
        agent: None,
        icon: (!session).then_some("icons/terminal.svg"),
        favorite: None,
        summary: summary.map(Into::into),
        attention: 0,
    }
}

fn rows() -> Vec<Row> {
    let mut selected = row(true, true, Some("Real project"));
    selected.selected = true;
    vec![
        row(true, true, None),
        row(true, false, None),
        row(false, false, None),
        row(false, true, None),
        row(true, false, Some("Real project")),
        row(
            true,
            false,
            Some("A project · Another project · A third project · And a fourth one"),
        ),
        selected,
    ]
}

struct Rows(Theme);
impl Render for Rows {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::tmux_snapshot::design::prepare(&self.0, false, cx);
        let bezel = bezel_theme::Theme::of(cx).clone();
        let painter = bezel_motion::Painter::of(cx);
        div().w(px(208.)).flex().flex_col().children(
            rows()
                .iter()
                .enumerate()
                .map(|(index, row)| render_row(index, row, &self.0, &bezel, painter, true)),
        )
    }
}

fn height(cx: &mut VisualTestContext, selector: String) -> f32 {
    f32::from(cx.debug_bounds(selector.leak()).unwrap().size.height)
}

/// The ladder's sizes are the rows' old ones at the default text size, and
/// the rows keep their leading, so nothing in the sidebar moves: a session
/// row with its count, without it, a fleet row with its icon, with a count,
/// and a session under a one- and a two-line activity summary.
#[gpui::test]
fn row_geometry_holds_at_the_default_text_size(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Rows(Theme::default()));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let rows: Vec<f32> = (0..6)
        .map(|index| height(cx, format!("tmux-sidebar-row-{index}")))
        .collect();
    assert_eq!(rows, [47.5, 29.5, 24.0, 42.0, 48.5, 64.5]);
    let labels: Vec<f32> = (0..6)
        .map(|index| height(cx, format!("tmux-sidebar-label-{index}")))
        .collect();
    assert_eq!(labels, [37.5, 19.5, 18.0, 36.0, 38.5, 54.5]);
    // A fleet row's label starts after its inset, its icon and the gap: the
    // icon is the ladder's body glyph.
    let row = cx.debug_bounds("tmux-sidebar-row-2").unwrap();
    let label = cx.debug_bounds("tmux-sidebar-label-2").unwrap();
    assert_eq!(
        label.left() - row.left(),
        px(bezel_theme::Theme::SPACE + 6. + bezel_theme::TextStyle::Body.painted() + 6.)
    );
}

/// Each text role a row paints (label, count, activity summary) is the row
/// ink, and reads at 4.5:1 on the frosted sidebar under every row fill, in
/// every catalog variant.
#[gpui::test]
fn every_row_text_role_reads_on_the_frosted_sidebar(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_global(InkProbes::default()));
    let (view, cx) = cx.add_window_view(|_, _| Rows(Theme::default()));
    let mut failures = Vec::new();
    for (name, appearance) in catalog() {
        let theme = appearance.native();
        view.update(cx, |view, _| view.0 = theme.clone());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let (label, muted) = row_ink(&theme);
        let plates = plates(&theme, true);
        let probes = cx.update(|_, cx| cx.global::<InkProbes>().0.clone());
        for (key, ink) in [
            ("sidebar-label-0", label),
            ("sidebar-label-6", label),
            ("sidebar-count-0", muted),
            ("sidebar-count-6", muted),
            ("sidebar-summary-4", muted),
            ("sidebar-summary-6", muted),
        ] {
            let painted = probes.get(key).copied();
            if painted != Some(rgb(ink).into()) {
                failures.push(format!("{name}: {key} painted {painted:?}"));
                continue;
            }
            let ratio = worst(rgb(ink).into(), &plates);
            if ratio < 4.5 {
                failures.push(format!("{name}: {key} is {ratio:.2}:1"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
