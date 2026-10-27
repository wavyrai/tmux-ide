//! The borders between panes that the daemon lets a pointer drag. Coordinates
//! are pixels from the paint origin, the grid that paints and hit-tests panes.

use gpui::CursorStyle;
use herdr_client::protocol::{PaneSurfaceFrame, PaneSurfaceSplit, PaneSurfaceSplitDirection};
use std::hash::{DefaultHasher, Hash, Hasher};

/// The split handle under a point, unless a popup covers the panes.
pub(crate) fn split_at(
    surface: &PaneSurfaceFrame,
    x: f32,
    y: f32,
    cell_width: f32,
    cell_height: f32,
) -> Option<&PaneSurfaceSplit> {
    if surface.popup.is_some()
        || !(cell_width > 0. && cell_height > 0.)
        || !(x >= 0. && y >= 0.)
        || !(x.is_finite() && y.is_finite())
    {
        return None;
    }
    let column = u16::try_from((x / cell_width) as u32).ok()?;
    let row = u16::try_from((y / cell_height) as u32).ok()?;
    surface
        .splits
        .iter()
        .find(|split| super::in_rect(split.hit_rect, column, row))
}

/// A horizontal split lays panes side by side, so its border moves along x.
pub(crate) fn along(direction: PaneSurfaceSplitDirection, x: f32, y: f32) -> f32 {
    match direction {
        PaneSurfaceSplitDirection::Horizontal => x,
        PaneSurfaceSplitDirection::Vertical => y,
    }
}

pub(crate) fn cursor(direction: PaneSurfaceSplitDirection) -> CursorStyle {
    match direction {
        PaneSurfaceSplitDirection::Horizontal => CursorStyle::ResizeLeftRight,
        PaneSurfaceSplitDirection::Vertical => CursorStyle::ResizeUpDown,
    }
}

/// Where the border starts along its axis.
pub(crate) fn edge(split: &PaneSurfaceSplit, cell_width: f32, cell_height: f32) -> f32 {
    let cell = match split.direction {
        PaneSurfaceSplitDirection::Horizontal => cell_width,
        PaneSurfaceSplitDirection::Vertical => cell_height,
    };
    f32::from(split.pos) * cell
}

/// The ratio that starts the border at `position` along its axis, within the
/// range Herdr's layout accepts; asking beyond it would only leave the border
/// behind the pointer. `None` for geometry that cannot divide the split.
pub(crate) fn ratio(
    split: &PaneSurfaceSplit,
    position: f32,
    cell_width: f32,
    cell_height: f32,
) -> Option<f32> {
    let (origin, length, cell) = match split.direction {
        PaneSurfaceSplitDirection::Horizontal => (split.area.x, split.area.width, cell_width),
        PaneSurfaceSplitDirection::Vertical => (split.area.y, split.area.height, cell_height),
    };
    let ratio = (position - f32::from(origin) * cell) / (f32::from(length) * cell);
    ratio.is_finite().then(|| ratio.clamp(0.1, 0.9))
}

/// Which panes and split paths a frame lays out. A path names a split by its
/// place in the tree, so a drag held across a close or split must not move
/// whichever border now sits at the same path.
pub(crate) fn topology(surface: &PaneSurfaceFrame) -> u64 {
    let mut panes = surface
        .panes
        .iter()
        .map(|pane| pane.pane_id.as_str())
        .collect::<Vec<_>>();
    panes.sort_unstable();
    let mut splits = surface
        .splits
        .iter()
        .map(|split| {
            let vertical = split.direction == PaneSurfaceSplitDirection::Vertical;
            (split.path.as_slice(), vertical)
        })
        .collect::<Vec<_>>();
    splits.sort_unstable();
    let mut hasher = DefaultHasher::new();
    panes.hash(&mut hasher);
    splits.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
