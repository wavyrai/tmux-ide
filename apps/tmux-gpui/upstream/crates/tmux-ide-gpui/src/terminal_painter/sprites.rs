//! Glyph sprites, resolved once per frame for each glyph, size, colour and
//! subpixel variant, and inserted into the scene in one batch.
//!
//! A grid repeats a few dozen glyphs in a few colours, so most cells reuse a
//! resolution from earlier in the frame: no raster-bounds lock, atlas lookup
//! or dilation per cell. Placement and the sprites themselves are GPUI's own
//! (`Window::glyph_placement`, `resolve_glyph`, `insert_glyphs`), so the scene
//! is the one `paint_glyph` and `paint_emoji` would build.
//!
//! The batch goes in ordered by atlas tile. `Scene::finish` sorts sprites by
//! draw order, then tile, keeping insertion order among equals; a layer gives
//! every glyph one draw order, so inserting them stably by tile yields the
//! scene it would sort to anyway, and its sort meets one long sorted run
//! instead of shuffling every glyph.

use gpui::{
    FontId, GlyphId, Hsla, Pixels, PlacedGlyph, Point, ResolvedGlyph, Result, ShapedLine, Window,
    point, px,
};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// The font, glyph, size, subpixel variant, colour and emoji flag a sprite
/// is rasterized for.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
    font: usize,
    glyph: u32,
    size: u32,
    variant: (u8, u8),
    color: [u32; 4],
    emoji: bool,
}

/// Multiply-rotate hashing: the keys are small integers, so SipHash's
/// resistance to chosen keys buys nothing here.
#[derive(Default)]
struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.write_u64(u64::from(*byte));
        }
    }
    fn write_u8(&mut self, n: u8) {
        self.write_u64(u64::from(n));
    }
    fn write_u32(&mut self, n: u32) {
        self.write_u64(u64::from(n));
    }
    fn write_usize(&mut self, n: usize) {
        self.write_u64(n as u64);
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

#[derive(Default)]
pub(super) struct Sprites {
    /// Each resolution and its slot in `tiles`.
    resolved: HashMap<Key, Option<(ResolvedGlyph, u32)>, BuildHasherDefault<Fx>>,
    /// Per slot: its tile id, then (in `flush`) its rank among the tiles.
    tiles: Vec<u32>,
    batch: Vec<PlacedGlyph>,
    /// The slot of each queued glyph.
    slots: Vec<u32>,
    /// Scratch for `flush`.
    ranks: Vec<(u32, u32)>,
    counts: Vec<u32>,
    ordered: Vec<PlacedGlyph>,
}

impl Sprites {
    /// Forgets the frame's resolutions: a window's scale factor or
    /// appearance may change between frames.
    pub(super) fn begin(&mut self) {
        self.resolved.clear();
        self.tiles.clear();
        self.batch.clear();
        self.slots.clear();
    }

    /// Queues `line`'s glyphs at `origin`, placed as `ShapedLine::paint` places
    /// them. An error leaves the rest of the line unqueued, as `paint_glyph`'s
    /// `?` would.
    pub(super) fn push_line(
        &mut self,
        line: &ShapedLine,
        origin: Point<Pixels>,
        line_height: Pixels,
        color: Hsla,
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
                self.push(
                    position,
                    run.font_id,
                    glyph.id,
                    line.font_size,
                    color,
                    glyph.is_emoji,
                    window,
                )?;
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        position: Point<Pixels>,
        font: FontId,
        glyph: GlyphId,
        font_size: Pixels,
        color: Hsla,
        emoji: bool,
        window: &mut Window,
    ) -> Result<()> {
        let placement = window.glyph_placement(position, emoji);
        let key = Key {
            font: font.0,
            glyph: glyph.0,
            size: f32::from(font_size).to_bits(),
            variant: (placement.variant.x, placement.variant.y),
            color: [
                color.h.to_bits(),
                color.s.to_bits(),
                color.l.to_bits(),
                color.a.to_bits(),
            ],
            emoji,
        };
        let resolved = match self.resolved.get(&key) {
            Some(resolved) => *resolved,
            None => {
                let resolved = window
                    .resolve_glyph(font, glyph, font_size, placement.variant, color, emoji)?
                    .map(|resolved| {
                        // Slots stay far below u32::MAX: one per distinct glyph in a frame.
                        let slot = u32::try_from(self.tiles.len()).unwrap_or(u32::MAX);
                        self.tiles.push(resolved.tile.tile_id.0);
                        (resolved, slot)
                    });
                self.resolved.insert(key, resolved);
                resolved
            }
        };
        if let Some((resolved, slot)) = resolved {
            self.slots.push(slot);
            self.batch.push(PlacedGlyph {
                origin: placement.origin,
                glyph: resolved,
                color,
                logical_origin: position,
                font_size,
            });
        }
        Ok(())
    }

    /// Inserts the queued glyphs ordered by tile, each tile's in the order
    /// they were queued: a counting sort over the frame's few distinct tiles.
    pub(super) fn flush(&mut self, window: &mut Window) {
        // Rank the slots by tile id; slots sharing a tile share a rank.
        self.ranks.clear();
        self.ranks.extend(
            (0..)
                .zip(self.tiles.iter())
                .map(|(slot, tile)| (*tile, slot)),
        );
        self.ranks.sort_unstable();
        let mut rank = 0;
        for index in 0..self.ranks.len() {
            if index > 0 && self.ranks[index].0 != self.ranks[index - 1].0 {
                rank += 1;
            }
            let slot = self.ranks[index].1 as usize;
            self.tiles[slot] = rank;
        }
        let ranks = if self.ranks.is_empty() {
            0
        } else {
            rank as usize + 1
        };
        self.counts.clear();
        self.counts.resize(ranks + 1, 0);
        for slot in &self.slots {
            self.counts[self.tiles[*slot as usize] as usize + 1] += 1;
        }
        for index in 1..self.counts.len() {
            self.counts[index] += self.counts[index - 1];
        }
        self.ordered.clear();
        self.ordered.extend_from_slice(&self.batch);
        for (glyph, slot) in self.batch.iter().zip(&self.slots) {
            let start = &mut self.counts[self.tiles[*slot as usize] as usize];
            self.ordered[*start as usize] = *glyph;
            *start += 1;
        }
        window.insert_glyphs(&self.ordered);
        self.batch.clear();
        self.slots.clear();
        // The slots now hold ranks, not tile ids: start the next batch afresh.
        self.tiles.clear();
        self.resolved.clear();
    }

    #[cfg(test)]
    pub(super) fn resolved_len(&self) -> usize {
        self.resolved.len()
    }
}
