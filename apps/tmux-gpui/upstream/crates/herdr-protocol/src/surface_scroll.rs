//! Adapted from herdr src/protocol/surface_scroll.rs (Apache-2.0, see NOTICE.md).
//! Modified: decoder and receiver only; geometry is checked against the
//! retained frame together with the ordinary patch bounds before any mutation.
//!
//! Scrolling output moves every visible row, so a row diff resends the whole
//! pane. This encoding carries each pane's vertical shift plus only the rows
//! that still differ afterwards.

use crate::{
    Error, MAX_FRAME_SIZE, PaneSurfaceFrame, PaneSurfacePatch, Result, ServerMessage, SurfaceRect,
    read_message, write_message,
};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};

pub const CAPABILITY: &str = "surface_scroll";
pub const MESSAGE_KIND: &str = "endpoint.surface-scroll.v1";

// This byte layout is frozen with MESSAGE_KIND: one count byte, then per
// scroll x, y, width, height (u16 LE) and shift (i16 LE), then one framed
// `ServerMessage::PaneSurfacePatch`, all base64 without padding.
pub const MAX_SCROLLS: usize = 64;
const SCROLL_BYTES: usize = 10;

/// Reorders the rows of one region before the patch rows apply.
///
/// A positive `shift` moves content up: row `y` shows the previous row
/// `y + shift`. Rows that scroll out rotate into the vacated rows, whose
/// final content the patch always carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceScroll {
    pub rect: SurfaceRect,
    pub shift: i16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrollPatch {
    pub scrolls: Vec<SurfaceScroll>,
    pub patch: PaneSurfacePatch,
}

/// Decodes one scroll message. Geometry is validated against the receiver's
/// frame by [`PaneSurfaceFrame::apply_scroll_patch`], never trusted here.
pub fn decode(data: &str) -> Result<ScrollPatch> {
    let limit = base64::encoded_len(MAX_FRAME_SIZE, false).unwrap_or(usize::MAX);
    if data.len() > limit {
        return Err(Error::EncodingLimit);
    }
    let bytes = STANDARD_NO_PAD.decode(data)?;
    let count = usize::from(*bytes.first().ok_or(Error::ScrollTruncated)?);
    if count == 0 || count > MAX_SCROLLS {
        return Err(Error::ScrollCount);
    }
    let header = 1 + count * SCROLL_BYTES;
    if bytes.len() < header {
        return Err(Error::ScrollTruncated);
    }
    let scrolls = bytes[1..header]
        .chunks_exact(SCROLL_BYTES)
        .map(|chunk| {
            let value = |at: usize| u16::from_le_bytes([chunk[at], chunk[at + 1]]);
            SurfaceScroll {
                rect: SurfaceRect {
                    x: value(0),
                    y: value(2),
                    width: value(4),
                    height: value(6),
                },
                shift: i16::from_le_bytes([chunk[8], chunk[9]]),
            }
        })
        .collect();
    let mut frame = &bytes[header..];
    let message = read_message::<_, ServerMessage>(&mut frame, MAX_FRAME_SIZE)?;
    if !frame.is_empty() {
        return Err(Error::TrailingBytes);
    }
    match message {
        ServerMessage::PaneSurfacePatch(patch) => Ok(ScrollPatch { scrolls, patch }),
        _ => Err(Error::ScrollPayload),
    }
}

impl ScrollPatch {
    /// The `EndpointControl` data a sender would emit; used by mock peers.
    pub fn encode(&self) -> Result<String> {
        let count = u8::try_from(self.scrolls.len()).map_err(|_| Error::ScrollCount)?;
        let mut bytes = vec![count];
        for scroll in &self.scrolls {
            let rect = scroll.rect;
            for value in [rect.x, rect.y, rect.width, rect.height] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes.extend_from_slice(&scroll.shift.to_le_bytes());
        }
        write_message(
            &mut bytes,
            &ServerMessage::PaneSurfacePatch(self.patch.clone()),
            MAX_FRAME_SIZE,
        )?;
        Ok(STANDARD_NO_PAD.encode(bytes))
    }
}

fn scroll_fits(scroll: &SurfaceScroll, width: u16, height: u16) -> bool {
    let rect = scroll.rect;
    rect.width > 0
        && rect.height >= 2
        && scroll.shift != 0
        && scroll.shift.unsigned_abs() < rect.height
        && rect
            .x
            .checked_add(rect.width)
            .is_some_and(|end| end <= width)
        && rect
            .y
            .checked_add(rect.height)
            .is_some_and(|end| end <= height)
}

// Callers check `scroll_fits` first, so these sums cannot overflow.
fn rects_overlap(a: SurfaceRect, b: SurfaceRect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/// The row swaps that define [`SurfaceScroll`]. Both peers must derive the
/// same row order, so this mirrors the sender's sequence exactly.
fn for_each_swap(height: usize, shift: i16, mut swap: impl FnMut(usize, usize)) {
    let distance = usize::from(shift.unsigned_abs());
    if shift > 0 {
        for y in 0..height - distance {
            swap(y, y + distance);
        }
    } else {
        for y in (distance..height).rev() {
            swap(y, y - distance);
        }
    }
}

impl PaneSurfaceFrame {
    /// Applies a scroll patch atomically: the regions and every ordinary patch
    /// bound are checked before any row moves, so a rejected update leaves the
    /// frame untouched.
    pub fn apply_scroll_patch(&mut self, scroll: ScrollPatch) -> Result<()> {
        let ScrollPatch { scrolls, patch } = scroll;
        self.validate_patch(&patch)?;
        let (width, height) = (self.frame.width, self.frame.height);
        if !scrolls
            .iter()
            .all(|scroll| scroll_fits(scroll, width, height))
        {
            return Err(Error::ScrollBounds);
        }
        // Disjoint regions keep the row rotation well defined.
        for (index, scroll) in scrolls.iter().enumerate() {
            if scrolls[index + 1..]
                .iter()
                .any(|other| rects_overlap(scroll.rect, other.rect))
            {
                return Err(Error::ScrollBounds);
            }
        }
        let stride = usize::from(width);
        for scroll in &scrolls {
            let rect = scroll.rect;
            let row_start = |y: usize| (usize::from(rect.y) + y) * stride + usize::from(rect.x);
            let (cells, span) = (&mut self.frame.cells, usize::from(rect.width));
            for_each_swap(usize::from(rect.height), scroll.shift, |a, b| {
                // Distinct rows of one region are at least a stride apart.
                let (low, high) = (row_start(a.min(b)), row_start(a.max(b)));
                let (head, tail) = cells.split_at_mut(high);
                head[low..low + span].swap_with_slice(&mut tail[..span]);
            });
        }
        self.commit_patch(patch);
        Ok(())
    }
}
