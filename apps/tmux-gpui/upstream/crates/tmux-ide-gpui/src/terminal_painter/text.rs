//! The glyph layer of a frame: shaped cell symbols, queued as sprites, with
//! whole rows of text retained between frames (see `rows`).
use super::rows::Basis;
use super::*;
#[cfg(feature = "visual-capture")]
use std::sync::atomic::Ordering::Relaxed;

impl TerminalPainter {
    /// Shapes and paints every visible glyph `area` covers, returning failures.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn paint_text(
        &mut self,
        frame: FrameView<'_>,
        area: &[Span],
        origin: Point<Pixels>,
        cell_width: f32,
        font: &Font,
        cached: bool,
        in_bar: &impl Fn(usize) -> bool,
        window: &mut Window,
        #[cfg(feature = "integration-test")] counts: &mut crate::performance::Counts,
    ) -> u64 {
        let mut paint_errors = 0;
        let mut glyph_color = GlyphColor::default();
        self.sprites.begin();
        #[cfg(feature = "visual-capture")]
        let legacy = self.legacy_glyphs || LEGACY_GLYPHS.load(Relaxed);
        #[cfg(not(feature = "visual-capture"))]
        let legacy = false;
        let retains = cached && !legacy;
        #[cfg(feature = "visual-capture")]
        let retains = retains && RETAIN_ROWS.load(Relaxed);
        if retains {
            self.rows.begin(Basis {
                raster: window.glyph_raster_state(),
                cell_width: cell_width.to_bits(),
                cell_height: self.cell_height.to_bits(),
            });
        }
        let width = usize::from(frame.width());
        for range in cell_ranges(frame, area) {
            let y = range.start / width;
            let top = origin.y + px(y as f32 * self.cell_height);
            let shared = (retains && range.len() == width)
                .then(|| frame.shared_row(y))
                .flatten()
                .filter(|_| !range.clone().any(in_bar));
            if let Some(row) = shared {
                if let Some(_glyphs) =
                    self.rows
                        .queue(row, origin.x, top, &mut self.sprites, window)
                {
                    #[cfg(feature = "integration-test")]
                    {
                        counts.glyphs += _glyphs;
                    }
                    continue;
                }
                self.sprites.recording = Some(self.rows.recorder());
            }
            let mut retainable = true;
            for index in range {
                let Some(cell) = frame.cell_at(index) else {
                    continue;
                };
                if cell.skip
                    || cell.symbol.is_empty()
                    || cell.symbol == " "
                    || in_bar(index)
                    || Graphic::from_symbol(&cell.symbol).is_some()
                {
                    continue;
                }
                if let Some(separator) = CellSeparator::from_symbol(&cell.symbol) {
                    let (column, row) = (
                        index % usize::from(frame.width()),
                        index / usize::from(frame.width()),
                    );
                    // A separator the daemon measures as wide spans its continuation cell,
                    // as the font glyph would.
                    let wide = column + 1 < usize::from(frame.width())
                        && frame.cell_at(index + 1).is_some_and(|next| next.skip);
                    let cells = if wide { 2 } else { 1 };
                    let (near, far) = grid_corners(
                        window,
                        origin,
                        point(
                            px(column as f32 * cell_width),
                            px(row as f32 * self.cell_height),
                        ),
                        point(
                            px((column + cells) as f32 * cell_width),
                            px((row + 1) as f32 * self.cell_height),
                        ),
                    );
                    // A degenerate cell whose path cannot tessellate keeps the font glyph.
                    if let Ok(path) = separator.path(near, far) {
                        let color = rgb(cell_colors(cell, &self.theme).0);
                        #[cfg(test)]
                        self.painted_separators.push((path.bounds, color));
                        window.paint_path(path, color);
                        #[cfg(feature = "integration-test")]
                        {
                            counts.paths += 1;
                        }
                        retainable = false;
                        continue;
                    }
                }
                let style = glyphs::style(cell.modifier);
                let newly_shaped;
                let shaped = match cached
                    .then(|| self.glyphs.get(style, &cell.symbol))
                    .flatten()
                {
                    Some(line) => line,
                    None => {
                        #[cfg(feature = "integration-test")]
                        {
                            counts.shapes += 1;
                        }
                        let line = self.shape(font, style, &cell.symbol, window);
                        if cached && self.glyphs.has_room() {
                            self.glyphs.insert(style, &cell.symbol, line)
                        } else {
                            newly_shaped = line;
                            &newly_shaped
                        }
                    }
                };
                let position = origin
                    + point(
                        px((index % usize::from(frame.width())) as f32 * cell_width),
                        px((index / usize::from(frame.width())) as f32 * self.cell_height),
                    );
                let color = glyph_color.get(cell_colors(cell, &self.theme).0);
                #[cfg(feature = "visual-capture")]
                let result = if legacy {
                    paint_glyphs(shaped, position, px(self.cell_height), color, window)
                } else {
                    self.sprites
                        .push_line(shaped, position, px(self.cell_height), color, window)
                };
                #[cfg(not(feature = "visual-capture"))]
                let result =
                    self.sprites
                        .push_line(shaped, position, px(self.cell_height), color, window);
                paint_errors += u64::from(result.is_err());
                retainable &= result.is_ok();
                #[cfg(feature = "integration-test")]
                {
                    counts.glyphs += shaped.runs.iter().map(|r| r.glyphs.len()).sum::<usize>();
                    counts.paint_errors += usize::from(result.is_err());
                }
            }
            if let Some(row) = shared {
                let recording = self.sprites.recording.take();
                self.rows
                    .retain(row, origin.x, recording.filter(|_| retainable));
            }
        }
        self.sprites.flush(window);
        if retains {
            self.rows.trim(4 * usize::from(frame.height()) + 64);
        }
        paint_errors
    }
}
