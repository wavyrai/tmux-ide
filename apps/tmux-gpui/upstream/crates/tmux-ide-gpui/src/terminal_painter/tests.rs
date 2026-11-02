use super::*;
use core::prelude::v1::test;
use herdr_client::protocol::FrameData;

mod cells;
mod composition;
mod diagnostics;
mod glyph_cache;
mod grid_edges;
mod row_frames;
// Paint counts are recorded only with the integration-test feature.
#[cfg(feature = "integration-test")]
mod layers;
mod placed_images;
mod prompt_geometry;

fn cell(symbol: &str) -> CellData {
    CellData {
        symbol: symbol.into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    }
}

#[test]
fn overlay_colours_come_from_the_bezel_palette() {
    let theme = Theme::default();
    let palette = crate::tmux_snapshot::design::palette(&theme);
    let overlay = Overlay::new(&theme);
    assert_eq!(overlay.thumb, palette.ink(0.2));
    assert_eq!(overlay.cursor, palette.cursor.opacity(0.5));
    assert_eq!(overlay.composition_text, palette.text);
    assert_eq!(overlay.composition_bg, palette.terminal_bg);
    let mut painter = TerminalPainter::default();
    let light = Theme {
        background: 0xffffff,
        ..Theme::default()
    };
    painter.set_appearance(FONT_SIZE, CELL_HEIGHT, light.clone());
    assert_eq!(painter.overlay, Overlay::new(&light));
}
