//! Retained glyph rows (R2): a row's sprites, kept from the frame that
//! painted it and queued again while the row is unchanged.
//!
//! A native frame's rows are immutable `Arc`s, and a row that did not change
//! keeps its `Arc`, also when it scrolls to another line. A row is retained
//! by identity: the cache holds the `Arc`, so its address cannot be reused
//! by another row while the entry lives, and a hit needs no hash of the
//! cells. A row painted at another height has its sprites' vertical
//! placement recomputed with the same arithmetic as `paint_glyph`, once per
//! baseline in the row; horizontal placement and the tiles carry over, since
//! subpixel variants only change with the vertical placement GPUI reports.
//!
//! Only whole rows of text are retained: a row with a separator path or a
//! scrollbar cell is painted cell by cell every frame.

use super::sprites::{FxMap, Sprites};
use gpui::{
    GlyphRasterState, Hsla, Pixels, PlacedGlyph, ResolvedGlyph, ScaledPixels, Window, point, px,
};
use herdr_client::protocol::CellData;
use std::sync::Arc;

/// Dev-only: rows queued from the cache, for the parity captures.
#[cfg(feature = "visual-capture")]
pub(crate) static ROW_HITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// One glyph of a retained row.
#[derive(Clone, Copy)]
pub(super) struct RowGlyph {
    pub x: ScaledPixels,
    pub variant_y: u8,
    pub logical_x: Pixels,
    /// The baseline's offset below the row's top.
    pub offset: Pixels,
    pub emoji: bool,
    pub glyph: ResolvedGlyph,
    pub color: Hsla,
    pub font_size: Pixels,
}

struct Entry {
    row: Arc<[CellData]>,
    origin_x: u32,
    used: u64,
    glyphs: Vec<RowGlyph>,
}

/// What every retained row depends on beyond its cells and its left edge.
#[derive(Clone, Copy, PartialEq)]
pub(super) struct Basis {
    pub raster: GlyphRasterState,
    pub cell_width: u32,
    pub cell_height: u32,
}

#[derive(Default)]
pub(super) struct Rows {
    entries: FxMap<usize, Entry>,
    basis: Option<Basis>,
    generation: u64,
    pool: Vec<Vec<RowGlyph>>,
    /// Per paint: each baseline's (offset, emoji, variant) and placed y.
    ys: Vec<(u32, bool, u8, ScaledPixels)>,
}

impl Rows {
    pub(super) fn clear(&mut self) {
        for (_, entry) in self.entries.drain() {
            self.pool.push(entry.glyphs);
        }
        self.basis = None;
    }

    /// Starts a paint; forgets every row if what rows depend on changed.
    pub(super) fn begin(&mut self, basis: Basis) {
        if self.basis != Some(basis) {
            self.clear();
            self.basis = Some(basis);
        }
        self.generation += 1;
    }

    /// Queues `row`'s retained sprites with its top at `top`, if it is
    /// retained for this left edge. False leaves `sprites` untouched.
    pub(super) fn queue(
        &mut self,
        row: &Arc<[CellData]>,
        origin_x: Pixels,
        top: Pixels,
        sprites: &mut Sprites,
        window: &Window,
    ) -> Option<usize> {
        let entry = self
            .entries
            .get_mut(&(Arc::as_ptr(row) as *const u8 as usize))?;
        if !Arc::ptr_eq(&entry.row, row) || entry.origin_x != f32::from(origin_x).to_bits() {
            return None;
        }
        self.ys.clear();
        for glyph in &entry.glyphs {
            let class = (f32::from(glyph.offset).to_bits(), glyph.emoji);
            let variant = match self.ys.iter().find(|y| (y.0, y.1) == class) {
                Some(y) => y.2,
                None => {
                    let placement =
                        window.glyph_placement(point(px(0.), top + glyph.offset), glyph.emoji);
                    self.ys
                        .push((class.0, class.1, placement.variant.y, placement.origin.y));
                    placement.variant.y
                }
            };
            // A vertical variant other than the recorded one needs other tiles.
            if variant != glyph.variant_y {
                return None;
            }
        }
        entry.used = self.generation;
        #[cfg(feature = "visual-capture")]
        ROW_HITS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        for glyph in &entry.glyphs {
            let class = (f32::from(glyph.offset).to_bits(), glyph.emoji);
            let y = self
                .ys
                .iter()
                .find(|y| (y.0, y.1) == class)
                .map_or(ScaledPixels(0.), |y| y.3);
            sprites.queue(PlacedGlyph {
                origin: point(glyph.x, y),
                glyph: glyph.glyph,
                color: glyph.color,
                logical_origin: point(glyph.logical_x, top + glyph.offset),
                font_size: glyph.font_size,
            });
        }
        Some(entry.glyphs.len())
    }

    /// A buffer to record a row into.
    pub(super) fn recorder(&mut self) -> Vec<RowGlyph> {
        let mut glyphs = self.pool.pop().unwrap_or_default();
        glyphs.clear();
        glyphs
    }

    /// Retains a recorded row; `None` drops the recording.
    pub(super) fn retain(
        &mut self,
        row: &Arc<[CellData]>,
        origin_x: Pixels,
        glyphs: Option<Vec<RowGlyph>>,
    ) {
        let Some(glyphs) = glyphs else {
            return;
        };
        let entry = Entry {
            row: Arc::clone(row),
            origin_x: f32::from(origin_x).to_bits(),
            used: self.generation,
            glyphs,
        };
        if let Some(old) = self
            .entries
            .insert(Arc::as_ptr(row) as *const u8 as usize, entry)
        {
            self.pool.push(old.glyphs);
        }
    }

    /// Drops rows unused in the last two paints once there are more than
    /// `limit`, keeping their buffers for later rows.
    pub(super) fn trim(&mut self, limit: usize) {
        if self.entries.len() <= limit {
            return;
        }
        let keep = self.generation.saturating_sub(2);
        let pool = &mut self.pool;
        self.entries.retain(|_, entry| {
            let kept = entry.used >= keep;
            if !kept {
                pool.push(std::mem::take(&mut entry.glyphs));
            }
            kept
        });
    }
}
