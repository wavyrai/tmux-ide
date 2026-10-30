#![allow(clippy::unwrap_used)]
//! The sidebar row on Bezel's nav-row recipe: `Selection` decides the fill.
use super::*;
use core::prelude::v1::test;
use gpui::{Hsla, Modifiers, TestAppContext};

fn row(selected: bool) -> Row {
    Row {
        label: "tmux-ide".into(),
        pane_count: Some("2 panes".into()),
        selected,
        target: Some(Target::Session("tmux-ide".into())),
        depth: 0,
        machine: None,
        agent: None,
        icon: None,
        favorite: None,
        summary: None,
        attention: 0,
    }
}

fn fill(element: &mut Stateful<Div>) -> Option<Hsla> {
    match element.style().background.clone()? {
        Fill::Color(background) => background.as_solid(),
    }
}

#[gpui::test]
fn selection_takes_bezel_fills_and_emphasis_follows_sidebar_focus(cx: &mut TestAppContext) {
    let theme = Theme::default();
    cx.update(|cx| {
        crate::tmux_snapshot::design::prepare(&theme, false, cx);
        let bezel = bezel_theme::Theme::of(cx).clone();
        let painter = bezel_motion::Painter::from(cx.new(|_| ()).entity_id());
        let mut focused = render_row(0, &row(true), &theme, &bezel, painter, true);
        let mut unfocused = render_row(1, &row(true), &theme, &bezel, painter, false);
        let mut resting = render_row(2, &row(false), &theme, &bezel, painter, true);
        assert_eq!(fill(&mut focused), Some(bezel.card_selected_bg()));
        assert!(
            !focused
                .style()
                .box_shadow
                .clone()
                .unwrap_or_default()
                .is_empty()
        );
        assert_eq!(fill(&mut unfocused), Some(bezel.element_hover));
        assert!(
            unfocused
                .style()
                .box_shadow
                .clone()
                .unwrap_or_default()
                .is_empty()
        );
        // At rest the hover fade has not started: the row shows the chrome.
        assert_eq!(fill(&mut resting), Some(bezel.ink(0.0)));
    });
}

/// Two rows in a window, the second with attention, so the tests can render,
/// hover and look at what was drawn.
struct Rows {
    rows: Vec<Row>,
}
impl Render for Rows {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::default();
        crate::tmux_snapshot::design::prepare(&theme, false, cx);
        let bezel = bezel_theme::Theme::of(cx).clone();
        let painter = bezel_motion::Painter::of(cx);
        div().size_full().flex().flex_col().children(
            self.rows
                .iter()
                .enumerate()
                .map(|(index, row)| render_row(index, row, &theme, &bezel, painter, false)),
        )
    }
}

fn fade(view: &Entity<Rows>, index: usize) -> f32 {
    let painter = bezel_motion::Painter::from(view.entity_id());
    bezel_motion::hover_t(&bezel_motion::Fade::new(
        painter,
        format!("sidebar-row-{index}"),
    ))
}

#[gpui::test]
fn attention_renders_a_badge_inside_its_row(cx: &mut TestAppContext) {
    let mut loud = row(false);
    loud.attention = 2;
    let (_, cx) = cx.add_window_view(|_, _| Rows {
        rows: vec![row(false), loud],
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-sidebar-attention-0").is_none());
    let badge = cx.debug_bounds("tmux-sidebar-attention-1").unwrap();
    let row = cx.debug_bounds("tmux-sidebar-row-1").unwrap();
    assert!(badge.size.width > px(0.) && badge.size.height > px(0.));
    assert!(badge.left() >= row.left() && badge.right() <= row.right());
}

#[gpui::test]
fn hovering_a_row_fades_in_its_own_wash(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, _| Rows {
        rows: vec![row(false), row(false)],
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let first = cx.debug_bounds("tmux-sidebar-row-0").unwrap();
    cx.simulate_mouse_move(first.center(), None, Modifiers::none());
    // The fade runs on wall time (150 ms); let it finish.
    std::thread::sleep(std::time::Duration::from_millis(250));
    assert_eq!(fade(&view, 0), 1.0, "the hovered row's fade ran");
    assert_eq!(fade(&view, 1), 0.0, "its neighbour's did not");
    // At the end of its fade the row paints Bezel's hover wash.
    cx.update(|_, cx| {
        let theme = Theme::default();
        let bezel = bezel_theme::Theme::of(cx).clone();
        let painter = bezel_motion::Painter::from(view.entity_id());
        let mut hovered = render_row(0, &row(false), &theme, &bezel, painter, false);
        assert_eq!(fill(&mut hovered), Some(bezel.element_hover));
    });
}

/// Catalog `blue` (dark): its foreground needs the row ink to read on a
/// selected row over the frost, so the row's ink and the bare chrome ink differ.
fn blue() -> Theme {
    Theme {
        background: 0x000000,
        foreground: 0x3377ee,
        surface: 0x00000a,
        active: 0x2c3a64,
        muted: 0x7185a8,
        ..Theme::default()
    }
}

#[gpui::test]
fn rows_paint_the_row_ink_and_a_filled_badge(cx: &mut TestAppContext) {
    let theme = blue();
    let (label, _) = crate::tmux_snapshot::design::row_ink(&theme);
    assert_ne!(
        label,
        crate::tmux_snapshot::design::chrome_text(&theme, theme.foreground),
        "this theme must tell the two inks apart"
    );
    cx.update(|cx| {
        crate::tmux_snapshot::design::prepare(&theme, false, cx);
        let bezel = bezel_theme::Theme::of(cx).clone();
        let painter = bezel_motion::Painter::from(cx.new(|_| ()).entity_id());
        let mut element = render_row(0, &row(true), &theme, &bezel, painter, true);
        let painted = element.style().text.color;
        assert_eq!(painted, Some(rgb(label).into()));
        let mut badge = attention_badge(&theme, &bezel, 2);
        let fill = match badge.style().background.clone() {
            Some(Fill::Color(background)) => background.as_solid(),
            None => None,
        };
        assert_eq!(fill, Some(rgb(theme.active).into()));
    });
}
