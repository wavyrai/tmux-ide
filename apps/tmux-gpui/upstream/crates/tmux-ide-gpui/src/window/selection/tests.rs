use super::*;
use crate::sidebar::layout_tests::fixture_window;
use gpui::{Modifiers, MouseButton, TestAppContext, point, px};
use herdr_client::protocol::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

mod clicks_and_scroll;
mod copy_on_select;
mod gestures;

fn surface(rows: &[&str], width: u16) -> PaneSurfaceFrame {
    let height = rows.len() as u16;
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width,
        height,
    };
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: FrameData {
            width,
            height,
            cells: rows
                .iter()
                .flat_map(|row| {
                    let mut symbols = row.chars();
                    (0..width).map(move |_| CellData {
                        symbol: symbols.next().unwrap_or(' ').to_string(),
                        fg: 0,
                        bg: 0,
                        modifier: 0,
                        skip: false,
                        hyperlink: None,
                    })
                })
                .collect(),
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        splits: vec![],
        popup: None,
        graphics: Default::default(),
        panes: vec![PaneSurfacePane {
            pane_id: "pane".into(),
            content_revision: 1,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: None,
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 100,
            pixel_height: 60,
        }],
    }
}
