mod area;
mod glyphs;
mod graphics;
mod grid;
mod images;

use self::area::whole;
pub(crate) use self::area::{Layer, Part, Span, cell_ranges, clip, covers};
use self::glyphs::GlyphCache;
use self::graphics::{CellSeparator, Graphic};
use self::grid::{background_extent, grid_corners, grid_rect, last_row_has_separator};
use self::images::{ImageCache, ImageGeometry, below_text};
pub(crate) use self::images::{ImageTarget, PlacedImages};
use crate::config::Theme;
use crate::terminal::*;
use gpui::*;
use herdr_client::protocol::{CellData, FrameData, PaneSurfacePane, SurfaceRect};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use unicode_width::UnicodeWidthStr;

/// The selection tints the cells it covers instead of replacing their colors:
/// a terminal's own background is meaningful, and the glyphs above it stay
/// readable on every theme.
const SELECTION_ALPHA: u32 = 0x59;
/// Search matches tint like the selection, the current one strongly enough to
/// find at a glance among the others.
const MATCH_ALPHA: u32 = 0x4d;
const CURRENT_MATCH_ALPHA: u32 = 0xa6;
const REPORT_INTERVAL: Duration = Duration::from_secs(5);
const SLOW_PAINT: Duration = Duration::from_millis(16);
const SCROLLBAR_INSET: f32 = 1.;
const SCROLLBAR_ALPHA: u32 = 0xc0;

/// Why a span of cells is tinted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tint {
    Selection,
    Match,
    CurrentMatch,
    /// The copy-mode cursor, drawn as a block over its cell.
    CopyCursor,
}

impl Tint {
    fn color(self, theme: &Theme) -> Rgba {
        match self {
            Self::Selection => rgba((theme.primary() << 8) | SELECTION_ALPHA),
            Self::Match => rgba((theme.palette[3] << 8) | MATCH_ALPHA),
            Self::CurrentMatch => rgba((theme.palette[3] << 8) | CURRENT_MATCH_ALPHA),
            Self::CopyCursor => rgba((theme.cursor << 8) | CURRENT_MATCH_ALPHA),
        }
    }
}

/// Tinted cells of one row, in the grid of the frame that paints them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Highlight {
    pub(crate) row: u16,
    pub(crate) columns: std::ops::Range<u16>,
    pub(crate) tint: Tint,
}

#[derive(Default)]
struct PaintTiming {
    count: u64,
    total: Duration,
    max: Duration,
    slow_count: u64,
}

struct PaintDiagnostics {
    since: Instant,
    timing: PaintTiming,
    last_error: Option<Instant>,
    errors: u64,
}

impl PaintDiagnostics {
    fn new(now: Instant) -> Self {
        Self {
            since: now,
            timing: PaintTiming::default(),
            last_error: None,
            errors: 0,
        }
    }

    fn record(&mut self, now: Instant, elapsed: Duration) -> Option<PaintTiming> {
        self.timing.count += 1;
        self.timing.total += elapsed;
        self.timing.max = self.timing.max.max(elapsed);
        self.timing.slow_count += u64::from(elapsed > SLOW_PAINT);
        if now.duration_since(self.since) < REPORT_INTERVAL {
            return None;
        }
        self.since = now;
        Some(std::mem::take(&mut self.timing))
    }

    fn take_errors(&mut self, now: Instant, errors: u64) -> Option<u64> {
        self.errors = self.errors.saturating_add(errors);
        if self.errors == 0
            || self
                .last_error
                .is_some_and(|last| now.duration_since(last) < REPORT_INTERVAL)
        {
            return None;
        }
        self.last_error = Some(now);
        Some(std::mem::take(&mut self.errors))
    }
}

pub(crate) struct TerminalPainter {
    font_size: f32,
    cell_height: f32,
    theme: Theme,
    config: Option<Font>,
    // Resolved foreground includes reverse, dim and hidden; only bold/italic
    // affect shaping. Decorations remain at exact cell-grid coordinates.
    glyphs: GlyphCache,
    cell_width: Option<f32>,
    diagnostics: PaintDiagnostics,
    images: ImageCache,
    /// Each image painted, with its z, in paint order.
    #[cfg(test)]
    painted_images: Vec<(i32, Bounds<Pixels>)>,
    #[cfg(test)]
    painted_separators: Vec<(Bounds<Pixels>, Rgba)>,
    #[cfg(feature = "integration-test")]
    pub uncached: bool,
}

impl Default for TerminalPainter {
    fn default() -> Self {
        Self {
            font_size: FONT_SIZE,
            cell_height: CELL_HEIGHT,
            theme: Theme::default(),
            config: None,
            glyphs: GlyphCache::default(),
            cell_width: None,
            diagnostics: PaintDiagnostics::new(Instant::now()),
            images: ImageCache::default(),
            #[cfg(test)]
            painted_images: Vec::new(),
            #[cfg(test)]
            painted_separators: Vec::new(),
            #[cfg(feature = "integration-test")]
            uncached: false,
        }
    }
}

/// The cell rectangle covering every in-frame cell of `rows`, if any.
fn link_bounds(frame: &FrameData, rows: &[(u16, std::ops::Range<u16>)]) -> Option<SurfaceRect> {
    let mut cells = rows.iter().filter_map(|(row, columns)| {
        let end = columns.end.min(frame.width);
        (*row < frame.height && columns.start < end).then_some((*row, columns.start, end))
    });
    let (row, start, end) = cells.next()?;
    let (top, bottom, left, right) = cells.fold(
        (row, row, start, end),
        |(top, bottom, left, right), (row, start, end)| {
            (
                top.min(row),
                bottom.max(row),
                left.min(start),
                right.max(end),
            )
        },
    );
    Some(SurfaceRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top + 1,
    })
}

fn decoration_offsets(cell: &CellData, cell_height: f32) -> impl Iterator<Item = f32> + '_ {
    [
        (UNDERLINE, cell_height - 2.),
        (STRIKETHROUGH, cell_height / 2.),
    ]
    .into_iter()
    .filter_map(|(modifier, y)| (cell.modifier & modifier != 0).then_some(y))
}

/// `ShapedLine::paint` without its per-call layer, whose BoundsTree insert
/// would otherwise run once per cell. Glyph placement matches GPUI's.
fn paint_glyphs(
    line: &ShapedLine,
    origin: Point<Pixels>,
    line_height: Pixels,
    color: Rgba,
    window: &mut Window,
) -> Result<()> {
    let baseline = origin
        + point(
            px(0.),
            (line_height - line.ascent - line.descent) / 2. + line.ascent,
        );
    for run in &line.runs {
        for glyph in &run.glyphs {
            let position = baseline + point(glyph.position.x, px(0.));
            if glyph.is_emoji {
                window.paint_emoji(position, run.font_id, glyph.id, line.font_size)?;
            } else {
                window.paint_glyph(
                    position,
                    run.font_id,
                    glyph.id,
                    line.font_size,
                    color.into(),
                )?;
            }
        }
    }
    Ok(())
}

fn background_spans<'a>(
    row: &'a [CellData],
    columns: std::ops::Range<usize>,
    theme: &'a Theme,
) -> impl Iterator<Item = (usize, usize, u32)> + 'a {
    // A wide glyph's continuation cell shows the glyph's background, as a host
    // terminal does: Herdr's ANSI renderer never draws that cell, so its own
    // background is not meant to be seen. Like that renderer, a halfwidth
    // katakana with a (semi-)voiced mark counts as two columns.
    let wide = |symbol: &str| {
        let mut chars = symbol.chars();
        symbol.width() > 1
            || matches!(
                (chars.next(), chars.next(), chars.next()),
                (
                    Some('\u{ff66}'..='\u{ff9d}'),
                    Some('\u{ff9e}' | '\u{ff9f}'),
                    None
                )
            )
    };
    let bg = move |x: usize| {
        let x = if x > 0 && wide(&row[x - 1].symbol) {
            x - 1
        } else {
            x
        };
        cell_colors(&row[x], theme).1
    };
    let mut start = columns.start;
    let stop = columns.end.min(row.len());
    std::iter::from_fn(move || {
        (start < stop).then_some(())?;
        let color = bg(start);
        let mut end = start + 1;
        while end < stop && bg(end) == color {
            end += 1;
        }
        let span = (start, end, color);
        start = end;
        Some(span)
    })
}

/// Where an IME composition sits: at the input cursor, shifted left only as
/// far as it takes to end inside the grid. Text wider than the grid loses its
/// start rather than its end, where the IME is editing.
fn composition_origin(cursor: Point<Pixels>, width: Pixels, grid: Bounds<Pixels>) -> Point<Pixels> {
    point(cursor.x.min(grid.right() - width), cursor.y)
}

/// The byte index of a UTF-16 offset, as the platform input handler counts.
fn byte_index(text: &str, utf16: usize) -> usize {
    let mut units = 0;
    text.char_indices()
        .find(|(_, c)| {
            let found = units >= utf16;
            units += c.len_utf16();
            found
        })
        .map_or(text.len(), |(index, _)| index)
}

impl TerminalPainter {
    pub fn set_appearance(&mut self, font_size: f32, cell_height: f32, theme: Theme) {
        if self.font_size != font_size || self.cell_height != cell_height || self.theme != theme {
            self.font_size = font_size;
            self.cell_height = cell_height;
            self.theme = theme;
            self.glyphs.clear();
            self.cell_width = None;
        }
    }

    #[cfg(feature = "integration-test")]
    pub fn reset_cache(&mut self) {
        self.config = None;
        self.glyphs.clear();
        self.cell_width = None;
    }

    #[cfg(feature = "integration-test")]
    pub fn verify_native_cache(&self, window: &Window) -> Result<usize> {
        let Some(base) = &self.config else {
            anyhow::bail!("missing font config");
        };
        for (style, symbol, cached) in self.glyphs.iter() {
            let fresh = self.shape(base, style, &symbol, window);
            // Includes native glyph IDs/positions, font IDs and metrics.
            if format!("{fresh:?}") != format!("{cached:?}") {
                anyhow::bail!("cached glyph/style mismatch: {symbol:?}");
            }
        }
        Ok(self.glyphs.len())
    }

    /// Glyphs for one cell symbol. Color is left to `paint_glyphs`, so one
    /// shape serves every color the symbol is drawn in.
    fn shape(&self, font: &Font, style: usize, symbol: &str, window: &Window) -> ShapedLine {
        let mut font = font.clone();
        let modifier = glyphs::style_modifier(style);
        if modifier & BOLD != 0 {
            font.weight = FontWeight::BOLD;
        }
        if modifier & ITALIC != 0 {
            font.style = FontStyle::Italic;
        }
        window.text_system().shape_line(
            SharedString::from(symbol.to_owned()),
            px(self.font_size),
            &[TextRun {
                len: symbol.len(),
                font,
                color: Hsla::default(),
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
            None,
        )
    }

    fn configure(&mut self, font: &Font) {
        if self.config.as_ref() != Some(font) {
            self.glyphs.clear();
            self.cell_width = None;
            self.config = Some(font.clone());
        }
    }

    pub fn cell_width(&mut self, font: &Font, window: &Window, cx: &mut App) -> f32 {
        self.configure(font);
        if let Some(width) = self.cell_width {
            return width;
        }
        let width = window
            .text_system()
            .shape_line(
                "M".into(),
                px(self.font_size),
                &[TextRun {
                    len: 1,
                    font: font.clone(),
                    color: rgb(self.theme.foreground).into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                }],
                None,
            )
            .width
            .to_f64() as f32;
        #[cfg(feature = "integration-test")]
        {
            cx.default_global::<crate::performance::Counts>()
                .metric_shapes += 1;
        }
        #[cfg(not(feature = "integration-test"))]
        let _ = cx;
        self.cell_width = Some(width);
        width
    }

    /// Underlines the cells of a hovered link, painted after `paint_frame`
    /// for the same frame and origin. Each cell takes its own text color, as
    /// an SGR underline would, and spaces along the link are underlined too.
    pub fn paint_link(
        &self,
        frame: &FrameData,
        origin: Point<Pixels>,
        cell_width: f32,
        rows: &[(u16, std::ops::Range<u16>)],
        window: &mut Window,
    ) {
        let Some(bounds) = link_bounds(frame, rows) else {
            return;
        };
        let layer = Bounds::new(
            origin
                + point(
                    px(f32::from(bounds.x) * cell_width),
                    px(f32::from(bounds.y) * self.cell_height),
                ),
            size(
                px(f32::from(bounds.width) * cell_width),
                px(f32::from(bounds.height) * self.cell_height),
            ),
        );
        window.paint_layer(layer, |window| {
            for (row, columns) in rows {
                if *row >= frame.height {
                    continue;
                }
                for column in columns.start..columns.end.min(frame.width) {
                    let index = usize::from(*row) * usize::from(frame.width) + usize::from(column);
                    let Some(data) = frame.cells.get(index) else {
                        continue;
                    };
                    let position = origin
                        + point(
                            px(f32::from(column) * cell_width),
                            px(f32::from(*row) * self.cell_height + self.cell_height - 2.),
                        );
                    window.paint_quad(fill(
                        Bounds::new(position, size(px(cell_width), px(1.))),
                        rgb(cell_colors(data, &self.theme).0),
                    ));
                }
            }
        });
    }

    /// Releases the textures of images no paint has placed for a while, for
    /// frames that paint without placing any.
    pub(crate) fn release_idle_images(&mut self, window: &mut Window) {
        self.images.release_idle(window);
    }

    /// Paints one layer of the cells of one frame that `part` covers, or
    /// every layer of all of them, tinting the cells `highlights` name in that frame's own grid. Rows
    /// outside the frame are ignored: a selection or search was made against
    /// the live surface, which a repaint may already have replaced.
    #[allow(clippy::too_many_arguments)]
    pub fn paint_frame(
        &mut self,
        frame: &FrameData,
        origin: Point<Pixels>,
        available: Option<Size<Pixels>>,
        cell_width: f32,
        font: &Font,
        highlights: &[Highlight],
        panes: &[PaneSurfacePane],
        part: Option<Part<'_>>,
        images: Option<PlacedImages<'_>>,
        window: &mut Window,
        cx: &mut App,
    ) {
        if frame.width == 0 {
            return;
        }
        // CPU scene construction only: this does not measure GPU completion.
        let started = Instant::now();
        let mut paint_errors = 0_u64;
        self.configure(font);
        let cached = true;
        #[cfg(feature = "integration-test")]
        let cached = cached && !self.uncached;
        #[cfg(feature = "integration-test")]
        let mut counts = crate::performance::Counts::default();
        let grid = Bounds::new(
            origin,
            size(
                px(f32::from(frame.width) * cell_width),
                px(f32::from(frame.height) * self.cell_height),
            ),
        );
        // Only fill a sub-cell remainder. Retained frames during resize and
        // mirrored groups must not stretch across whole missing rows/columns.
        // Popups have no remainder; their background stays inside their grid.
        let background = available.map_or(grid.size, |available| {
            background_extent(
                grid.size,
                available,
                size(px(cell_width), px(self.cell_height)),
            )
        });
        let extend_last_row =
            background.height > grid.size.height && !last_row_has_separator(frame);
        let whole_area;
        let area = match part {
            Some(part) => part.area,
            None => {
                whole_area = whole(frame);
                &whole_area
            }
        };
        let draws = |layer| part.is_none_or(|part| part.layer == layer);
        // The daemon's cell scrollbar is replaced by the pixel thumb painted below.
        let bars: Vec<SurfaceRect> = panes.iter().filter_map(|p| p.scrollbar_rect).collect();
        let in_bar = |index: usize| {
            let width = usize::from(frame.width);
            bars.iter()
                .any(|r| in_rect(*r, (index % width) as u16, (index / width) as u16))
        };
        let placed = images.map_or_else(Vec::new, |images| {
            self.images.prepare(
                images,
                origin,
                (cell_width, self.cell_height),
                grid,
                window,
                cx,
            )
        });
        let (below, above): (Vec<_>, Vec<_>) =
            placed.into_iter().partition(|(z, ..)| below_text(*z));
        // Text shares the backgrounds' layer unless something must come
        // between them: images below the text, or another region's cells.
        let text_with_backgrounds = part.is_none() && below.is_empty();
        // A layer gives all its primitives one draw order, skipping GPUI's
        // per-primitive BoundsTree insert that dominates large grids. Within a
        // layer quads draw before glyphs, so decorations and the cursor take a
        // second layer above the text.
        if draws(Layer::Backgrounds) {
            window.paint_layer(Bounds::new(origin, background), |window| {
                // Backgrounds precede all glyphs, including wide graphemes' skip cells.
                let width = usize::from(frame.width);
                for range in cell_ranges(frame, area) {
                    let y = range.start / width;
                    let row = &frame.cells[y * width..((y + 1) * width).min(frame.cells.len())];
                    let columns = range.start - y * width..range.end - y * width;
                    let mut paint = |start: usize, end: usize, color| {
                        let right = if end == usize::from(frame.width) {
                            background.width
                        } else {
                            px(end as f32 * cell_width)
                        };
                        let bottom = if extend_last_row && y + 1 == usize::from(frame.height) {
                            background.height
                        } else {
                            px((y + 1) as f32 * self.cell_height)
                        };
                        let bounds = grid_rect(
                            window,
                            origin,
                            point(
                                px(start as f32 * cell_width),
                                px(y as f32 * self.cell_height),
                            ),
                            point(right, bottom),
                        );
                        window.paint_quad(fill(bounds, rgb(color)));
                        #[cfg(feature = "integration-test")]
                        {
                            counts.quads += 1;
                        }
                    };
                    if cached {
                        for (start, end, color) in background_spans(row, columns, &self.theme) {
                            paint(start, end, color);
                        }
                    } else {
                        for x in columns {
                            paint(x, x + 1, cell_colors(&row[x], &self.theme).1);
                        }
                    }
                }
                // Between the backgrounds and the glyphs, so the tint reads as chosen
                // without hiding either.
                for Highlight { row, columns, tint } in &clip(highlights, area) {
                    let (start, end) =
                        (columns.start.min(frame.width), columns.end.min(frame.width));
                    if *row >= frame.height || start >= end {
                        continue;
                    }
                    let (top, bottom) = (f32::from(*row), f32::from(*row) + 1.);
                    window.paint_quad(fill(
                        grid_rect(
                            window,
                            origin,
                            point(
                                px(f32::from(start) * cell_width),
                                px(top * self.cell_height),
                            ),
                            point(
                                px(f32::from(end) * cell_width),
                                px(bottom * self.cell_height),
                            ),
                        ),
                        tint.color(&self.theme),
                    ));
                    #[cfg(feature = "integration-test")]
                    {
                        counts.quads += 1;
                    }
                }
                if text_with_backgrounds {
                    paint_errors += self.paint_text(
                        frame,
                        area,
                        origin,
                        cell_width,
                        font,
                        cached,
                        &in_bar,
                        window,
                        #[cfg(feature = "integration-test")]
                        &mut counts,
                    );
                }
            });
        }
        if !text_with_backgrounds && draws(Layer::Text) {
            paint_errors += self.paint_images(&below, window);
            window.paint_layer(grid, |window| {
                paint_errors += self.paint_text(
                    frame,
                    area,
                    origin,
                    cell_width,
                    font,
                    cached,
                    &in_bar,
                    window,
                    #[cfg(feature = "integration-test")]
                    &mut counts,
                );
            });
        }
        if draws(Layer::Decorations) {
            window.paint_layer(grid, |window| {
                // Box and block graphics are quads, so they share this layer to stay
                // above the backgrounds. Decorations cover the grid, including spaces
                // and wide-glyph continuation cells.
                for index in cell_ranges(frame, area).flatten() {
                    let cell = &frame.cells[index];
                    if in_bar(index) {
                        continue;
                    }
                    let position = origin
                        + point(
                            px((index % usize::from(frame.width)) as f32 * cell_width),
                            px((index / usize::from(frame.width)) as f32 * self.cell_height),
                        );
                    if let Some(graphic) = (!cell.skip)
                        .then(|| Graphic::from_symbol(&cell.symbol))
                        .flatten()
                    {
                        let color = rgb(cell_colors(cell, &self.theme).0);
                        graphic.rectangles(
                            Bounds::new(position, size(px(cell_width), px(self.cell_height))),
                            window.scale_factor(),
                            |bounds| {
                                window.paint_quad(fill(bounds, color));
                                #[cfg(feature = "integration-test")]
                                {
                                    counts.quads += 1;
                                }
                            },
                        );
                    }
                    let (column, row) = (
                        index % usize::from(frame.width),
                        index / usize::from(frame.width),
                    );
                    for y in decoration_offsets(cell, self.cell_height) {
                        // Absolute corners keep a run of underlined cells one unbroken line.
                        let top = row as f32 * self.cell_height + y;
                        window.paint_quad(fill(
                            grid_rect(
                                window,
                                origin,
                                point(px(column as f32 * cell_width), px(top)),
                                point(px((column + 1) as f32 * cell_width), px(top + 1.)),
                            ),
                            rgb(cell_colors(cell, &self.theme).0),
                        ));
                        #[cfg(feature = "integration-test")]
                        {
                            counts.decorations += 1;
                        }
                    }
                }
                if let Some(cursor) = frame.cursor.as_ref().filter(|c| {
                    c.visible && c.x < frame.width && c.y < frame.height && covers(area, c.x, c.y)
                }) {
                    let position = origin + cursor_offset(cursor, cell_width, self.cell_height);
                    let (offset, dimensions) = match cursor.shape {
                        3 | 4 => (
                            point(px(0.), px(self.cell_height - 2.)),
                            size(px(cell_width), px(2.)),
                        ),
                        5 | 6 => (point(px(0.), px(0.)), size(px(2.), px(self.cell_height))),
                        _ => (
                            point(px(0.), px(0.)),
                            size(px(cell_width), px(self.cell_height)),
                        ),
                    };
                    window.paint_quad(fill(
                        Bounds::new(position + offset, dimensions),
                        rgba((self.theme.cursor << 8) | 0x80),
                    ));
                    #[cfg(feature = "integration-test")]
                    {
                        counts.decorations += 1;
                    }
                }
                // A scrollbar paints with the cells at its top, so one paint owns it.
                for bar in panes
                    .iter()
                    .filter(|pane| {
                        pane.scrollbar_rect
                            .is_some_and(|rect| covers(area, rect.x, rect.y))
                    })
                    .filter_map(|pane| Scrollbar::new(pane, cell_width, self.cell_height))
                {
                    let width =
                        (f32::from(bar.track.size.width) - 2. * SCROLLBAR_INSET).clamp(2., 6.);
                    window.paint_quad(
                        fill(
                            Bounds::new(
                                origin
                                    + point(
                                        bar.track.right() - px(width + SCROLLBAR_INSET),
                                        bar.thumb.top(),
                                    ),
                                size(px(width), bar.thumb.size.height),
                            ),
                            rgba((self.theme.muted << 8) | SCROLLBAR_ALPHA),
                        )
                        .corner_radii(px(width / 2.)),
                    );
                }
            });
        }
        // Kitty draws `z >= 0` over the text, decorations and cursor included.
        paint_errors += self.paint_images(&above, window);
        #[cfg(feature = "integration-test")]
        {
            let total = cx.default_global::<crate::performance::Counts>();
            total.shapes += counts.shapes;
            total.quads += counts.quads;
            total.glyphs += counts.glyphs;
            total.paths += counts.paths;
            total.decorations += counts.decorations;
            total.paint_errors += counts.paint_errors;
            total.paints += 1;
        }
        #[cfg(not(feature = "integration-test"))]
        let _ = cx;
        let now = Instant::now();
        if let Some(timing) = self.diagnostics.record(now, now.duration_since(started)) {
            let mean_ms = timing.total.as_secs_f64() * 1000. / timing.count as f64;
            let max_ms = timing.max.as_secs_f64() * 1000.;
            if timing.slow_count > 0 {
                tracing::warn!(
                    count = timing.count,
                    mean_ms,
                    max_ms,
                    slow_count = timing.slow_count,
                    "Terminal CPU paint timing"
                );
            } else {
                tracing::debug!(
                    count = timing.count,
                    mean_ms,
                    max_ms,
                    slow_count = timing.slow_count,
                    "Terminal CPU paint timing"
                );
            }
        }
        if let Some(count) = self.diagnostics.take_errors(now, paint_errors) {
            tracing::warn!(category = "glyph_paint", count, "Terminal paint failed");
        }
    }

    /// Paints images in order, returning how many failed.
    fn paint_images(
        &mut self,
        placed: &[(i32, ImageGeometry, Arc<RenderImage>)],
        window: &mut Window,
    ) -> u64 {
        let mut failed = 0;
        for (_z, geometry, texture) in placed {
            let painted = window.paint_image(
                geometry.visible,
                geometry.image,
                Corners::default(),
                texture.clone(),
                0,
                false,
            );
            failed += u64::from(painted.is_err());
            #[cfg(test)]
            self.painted_images.push((*_z, geometry.visible));
        }
        failed
    }

    /// Shapes and paints every visible glyph `area` covers, returning failures.
    #[allow(clippy::too_many_arguments)]
    fn paint_text(
        &mut self,
        frame: &FrameData,
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
        for index in cell_ranges(frame, area).flatten() {
            let cell = &frame.cells[index];
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
                    index % usize::from(frame.width),
                    index / usize::from(frame.width),
                );
                // A separator the daemon measures as wide spans its continuation cell,
                // as the font glyph would.
                let wide = column + 1 < usize::from(frame.width)
                    && frame.cells.get(index + 1).is_some_and(|next| next.skip);
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
                    px((index % usize::from(frame.width)) as f32 * cell_width),
                    px((index / usize::from(frame.width)) as f32 * self.cell_height),
                );
            let color = rgb(cell_colors(cell, &self.theme).0);
            let result = paint_glyphs(shaped, position, px(self.cell_height), color, window);
            paint_errors += u64::from(result.is_err());
            #[cfg(feature = "integration-test")]
            {
                counts.glyphs += shaped.runs.iter().map(|r| r.glyphs.len()).sum::<usize>();
                counts.paint_errors += usize::from(result.is_err());
            }
        }
        paint_errors
    }

    /// Paints an uncommitted IME composition over the cells at the input
    /// cursor. It is shaped as one line rather than per cell, so it can span
    /// wide glyphs, and it bypasses the glyph cache since it changes with
    /// every keystroke. Nothing reaches the pane until the IME commits.
    pub fn paint_composition(
        &self,
        text: &str,
        cursor: Point<Pixels>,
        grid: Bounds<Pixels>,
        font: &Font,
        window: &mut Window,
    ) {
        if text.is_empty() {
            return;
        }
        let line = self.shape(font, 0, text, window);
        let origin = composition_origin(cursor, line.width, grid);
        let bounds = Bounds::new(origin, size(line.width, px(self.cell_height)));
        let color = rgb(self.theme.foreground);
        // A layer of its own, painted after the frame, keeps it above the
        // cells and the cursor it covers. It clips to the input area, so text
        // wider than a popup never paints over the pane beneath it.
        window.with_content_mask(Some(ContentMask { bounds: grid }), |window| {
            window.paint_layer(bounds, |window| {
                window.paint_quad(fill(bounds, rgb(self.theme.background)));
                window.paint_quad(fill(
                    Bounds::new(
                        origin + point(px(0.), px(self.cell_height - 2.)),
                        size(line.width, px(1.)),
                    ),
                    color,
                ));
                if paint_glyphs(&line, origin, px(self.cell_height), color, window).is_err() {
                    tracing::warn!(category = "glyph_paint", "IME composition paint failed");
                }
            });
        });
    }

    /// The bounds of `range` (UTF-16) within a composition painted by
    /// `paint_composition`, so the IME can place its candidate window under
    /// the clause being converted.
    pub fn composition_bounds(
        &self,
        text: &str,
        range: std::ops::Range<usize>,
        cursor: Bounds<Pixels>,
        grid: Bounds<Pixels>,
        font: &Font,
        window: &Window,
    ) -> Bounds<Pixels> {
        if text.is_empty() {
            return cursor;
        }
        let line = self.shape(font, 0, text, window);
        let origin = composition_origin(cursor.origin, line.width, grid);
        let start = line.x_for_index(byte_index(text, range.start));
        let end = line.x_for_index(byte_index(text, range.end));
        let width = (end - start).max(cursor.size.width);
        // A caret after the text, or a clause scrolled off the left, still
        // anchors the candidate window inside the grid.
        let x = (origin.x + start)
            .min(grid.right() - width)
            .max(grid.left());
        Bounds::new(point(x, origin.y), size(width, cursor.size.height))
    }
}

#[cfg(test)]
mod tests;
