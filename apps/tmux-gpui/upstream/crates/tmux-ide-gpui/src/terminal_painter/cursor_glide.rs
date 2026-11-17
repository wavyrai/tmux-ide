//! The gliding cursor: when the terminal cursor moves a short way, it slides
//! to its new cell instead of jumping there.
//!
//! Positions are in cells, not pixels, so a card layout's translation applies
//! to the glide as it does to the cell. The glide never delays the text: the
//! frame that shows a typed character also shows the cursor most of the way
//! to its new cell, and only the cursor quad moves on the frames after it.
//! When the cursor is still, nothing asks for another frame.
use std::time::{Duration, Instant};

/// How long a glide lasts, counted from one frame before the paint that
/// first shows the move.
pub(crate) const GLIDE: Duration = Duration::from_millis(70);
/// The glide starts one frame early, so the first frame already shows it
/// past half-way: a typed character's cursor moves with the character.
const HEAD_START: Duration = Duration::from_micros(16_667);
/// Moves across more rows than this snap: a wrap or newline glides, a
/// screen clear or a jump through a long listing does not.
const MAX_ROWS: u16 = 2;

/// One cursor cell in the frame's grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Cell {
    pub x: u16,
    pub y: u16,
}

/// Where the cursor is drawn, in fractional cells.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Drawn {
    pub x: f32,
    pub y: f32,
}

impl From<Cell> for Drawn {
    fn from(cell: Cell) -> Self {
        Self {
            x: f32::from(cell.x),
            y: f32::from(cell.y),
        }
    }
}

/// What one paint shows: the visible cursor's cell, if any, and the scene it
/// sits in. A different scene (another pane or session, a focus change, a
/// resize, the alternate screen, a scroll) always snaps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub cell: Option<Cell>,
    pub scene: u64,
    /// Glides are allowed: the setting is on and Reduce Motion is off.
    pub animate: bool,
}

#[derive(Default)]
pub(crate) struct CursorGlide {
    /// The last visible cell and its scene.
    target: Option<(Cell, u64)>,
    from: Option<Drawn>,
    started: Option<Instant>,
    /// When the last paint observed the cursor; every paint of that frame
    /// draws the position at this instant.
    at: Option<Instant>,
}

impl CursorGlide {
    /// Records what this paint shows and returns whether the cursor is still
    /// moving, so the caller asks for one more frame. A still cursor returns
    /// `false`.
    pub(crate) fn observe(&mut self, target: Target, now: Instant) -> bool {
        let Some(cell) = target.cell else {
            // Hidden or gone: the next visible cursor appears where it is.
            *self = Self::default();
            return false;
        };
        match self.target {
            Some((old, scene)) if old == cell && scene == target.scene => {
                if !target.animate {
                    self.started = None;
                }
            }
            Some((old, scene))
                if target.animate
                    && scene == target.scene
                    && old.y.abs_diff(cell.y) <= MAX_ROWS =>
            {
                // From wherever the cursor is drawn now, mid-glide included.
                self.from = Some(self.position(now));
                self.started = Some(now.checked_sub(HEAD_START).unwrap_or(now));
            }
            _ => {
                self.from = None;
                self.started = None;
            }
        }
        self.target = Some((cell, target.scene));
        self.at = Some(now);
        self.moving(now)
    }

    /// Where to draw the cursor that sits in `cell` this frame: its glide
    /// position when this glide tracks that cell, else the cell itself.
    pub(crate) fn drawn(&self, cell: Cell) -> Drawn {
        match (self.target, self.at) {
            (Some((target, _)), Some(at)) if target == cell => self.position(at),
            _ => cell.into(),
        }
    }

    fn moving(&self, now: Instant) -> bool {
        self.started
            .is_some_and(|started| now.saturating_duration_since(started) < GLIDE)
    }

    fn position(&self, now: Instant) -> Drawn {
        let Some((cell, _)) = self.target else {
            return Drawn { x: 0., y: 0. };
        };
        let to = Drawn::from(cell);
        let (Some(from), Some(started)) = (self.from, self.started) else {
            return to;
        };
        let t = now.saturating_duration_since(started).as_secs_f32() / GLIDE.as_secs_f32();
        if t >= 1. {
            return to;
        }
        let eased = ease_out(t);
        Drawn {
            x: from.x + (to.x - from.x) * eased,
            y: from.y + (to.y - from.y) * eased,
        }
    }
}

/// Cubic ease-out: fast away from the old cell, settling into the new one.
fn ease_out(t: f32) -> f32 {
    let rest = 1. - t.clamp(0., 1.);
    1. - rest * rest * rest
}

#[cfg(test)]
#[path = "cursor_glide_tests.rs"]
mod tests;
