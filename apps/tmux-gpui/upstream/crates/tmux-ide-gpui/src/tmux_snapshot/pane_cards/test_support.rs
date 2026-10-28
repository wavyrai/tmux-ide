#![allow(clippy::unwrap_used)]
use super::*;
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn test_cell_point(&self, col: f32, row: f32) -> Point<Pixels> {
        let width = self.input_cell_width.unwrap();
        let height = self.terminal_height();
        let origin = self.input_geometry.unwrap().0.origin;
        let Some(layout) = self.card_layout(width) else {
            return origin + point(px(col * width), px(row * height));
        };
        let c = col.floor() as u16;
        let r = row.floor() as u16;
        if layout
            .regions
            .iter()
            .any(|p| c >= p.left && c < p.left + p.width && r >= p.top && r < p.top + p.height)
        {
            return origin
                + layout.cursor(c, r)
                + point(px(col.fract() * width), px(row.fract() * height));
        }
        let x = if layout.x.contains(&(c + 1)) {
            f32::from(c) * width + layout.shift(c, true) + 2. * PAD + GAP / 2.
        } else {
            col * width + layout.shift(c, true) + PAD
        };
        let y = if layout.y.contains(&(r + 1)) {
            f32::from(r) * height + layout.shift(r, false) + HEADER + 2. * V_PAD + GAP / 2.
        } else {
            row * height + layout.shift(r, false) + HEADER + V_PAD
        };
        origin + point(px(x), px(y))
    }
    pub(in crate::tmux_snapshot) fn test_fitted_grid(&self) -> (u16, u16) {
        let width = self.input_cell_width.unwrap();
        let canvas = self.input_geometry.unwrap().0;
        let overhead = self
            .card_layout(width)
            .map_or(size(px(0.), px(0.)), |l| l.overhead());
        super::super::geometry::cell_grid(
            f32::from(canvas.size.width - overhead.width),
            f32::from(canvas.size.height - overhead.height),
            width,
            self.terminal_height(),
        )
        .unwrap()
    }
}
