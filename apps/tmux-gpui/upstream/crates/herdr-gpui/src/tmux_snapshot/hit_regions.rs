//! Hit targets share the verified window canvas's cell coordinates.
use super::browser::Choice;
use herdr_client::protocol::FrameData;
use serde::Deserialize;
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Region {
    pub(super) id: String,
    pub(super) left: u16,
    pub(super) top: u16,
    pub(super) width: u16,
    pub(super) height: u16,
}
pub(super) fn valid(regions: &[Region], frame: Option<&FrameData>, choices: &[Choice]) -> bool {
    if regions.is_empty() {
        return true;
    }
    let Some(frame) = frame else {
        return false;
    };
    let mut ids = std::collections::HashSet::new();
    regions.len() <= 24
        && regions.iter().enumerate().all(|(i, r)| {
            r.width > 0
                && r.height > 0
                && u32::from(r.left) + u32::from(r.width) <= u32::from(frame.width)
                && u32::from(r.top) + u32::from(r.height) <= u32::from(frame.height)
                && choices.iter().any(|c| c.id == r.id)
                && ids.insert(&r.id)
                && regions[..i].iter().all(|p| {
                    u32::from(r.left) >= u32::from(p.left) + u32::from(p.width)
                        || u32::from(p.left) >= u32::from(r.left) + u32::from(r.width)
                        || u32::from(r.top) >= u32::from(p.top) + u32::from(p.height)
                        || u32::from(p.top) >= u32::from(r.top) + u32::from(r.height)
                })
        })
}
pub(super) fn is_painted(
    current: Option<&std::sync::Arc<FrameData>>,
    painted: Option<&std::sync::Arc<FrameData>>,
) -> bool {
    current
        .zip(painted)
        .is_some_and(|(current, painted)| std::sync::Arc::ptr_eq(current, painted))
}
pub(super) fn hit(regions: &[Region], x: f32, y: f32, width: f32, height: f32) -> Option<&str> {
    if ![x, y, width, height].iter().all(|v| v.is_finite())
        || x < 0.
        || y < 0.
        || width <= 0.
        || height <= 0.
    {
        return None;
    }
    let col = (x / width).floor();
    let row = (y / height).floor();
    regions
        .iter()
        .find(|r| {
            col >= f32::from(r.left)
                && col < f32::from(r.left) + f32::from(r.width)
                && row >= f32::from(r.top)
                && row < f32::from(r.top) + f32::from(r.height)
        })
        .map(|r| r.id.as_str())
}
#[derive(Debug, PartialEq, Eq)]
pub(super) struct SeparatorCell {
    pub col: u16,
    pub row: u16,
    pub vertical: bool,
}

/// Carve only adjacent unused cells; all pane rectangles (including any status
/// rows) are protected. Never borrow a terminal cell to manufacture an outline.
pub(super) fn separator_cells(
    selected: &str,
    regions: &[Region],
    frame: &FrameData,
    choices: &[Choice],
) -> Vec<SeparatorCell> {
    if frame.width > 1000
        || frame.height > 500
        || !frame.graphics.is_empty()
        || !valid(regions, Some(frame), choices)
    {
        return Vec::new();
    }
    let Some(pane) = regions.iter().find(|r| r.id == selected) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    let mut candidate = |col: u16, row: u16, vertical: bool| {
        if col >= frame.width
            || row >= frame.height
            || regions.iter().any(|r| {
                col >= r.left
                    && u32::from(col) < u32::from(r.left) + u32::from(r.width)
                    && row >= r.top
                    && u32::from(row) < u32::from(r.top) + u32::from(r.height)
            })
        {
            return;
        }
        // Defense in depth: a publication containing visible data in a gap is
        // not an unused separator, even if its rectangles say otherwise.
        let index = usize::from(row) * usize::from(frame.width) + usize::from(col);
        if frame.cells.get(index).is_none_or(|cell| {
            !matches!(cell.symbol.as_str(), "" | " ")
                || cell.skip
                || cell.modifier != 0
                || cell.fg != 0
                || cell.bg != 0
                || cell.hyperlink.is_some()
        }) {
            return;
        }
        result.push(SeparatorCell { col, row, vertical });
    };
    for row in pane.top..pane.top + pane.height {
        if let Some(left) = pane.left.checked_sub(1) {
            candidate(left, row, true);
        }
        candidate(pane.left + pane.width, row, true);
    }
    for col in pane.left..pane.left + pane.width {
        if let Some(top) = pane.top.checked_sub(1) {
            candidate(col, top, false);
        }
        candidate(col, pane.top + pane.height, false);
    }
    result
}

#[cfg(test)]
#[path = "hit_regions_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "separator_tests.rs"]
mod separator_tests;
