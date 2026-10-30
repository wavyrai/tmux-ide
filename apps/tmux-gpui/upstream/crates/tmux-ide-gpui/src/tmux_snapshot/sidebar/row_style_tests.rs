#![allow(clippy::unwrap_used)]
//! The sidebar row on Bezel's nav-row recipe: `Selection` decides the fill.
use super::*;
use core::prelude::v1::test;
use gpui::{Hsla, TestAppContext};

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
