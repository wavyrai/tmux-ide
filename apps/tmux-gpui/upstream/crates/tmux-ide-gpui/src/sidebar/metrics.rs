//! Sidebar geometry. The same numbers feed layout, hit testing, and the
//! label budgets, so a row never paints wider than it was measured.

use crate::config::FontConfig;
use std::time::Duration;

pub(super) const SIDEBAR_WIDTH: f32 = 232.;
/// How long the pointer rests on a workspace row before its menu opens, so the
/// same actions a right click offers are reachable without one.
pub(super) const HOVER_MENU_DELAY: Duration = Duration::from_millis(600);
/// Pointer drift, in pixels, that still counts as resting on the row.
pub(super) const HOVER_MENU_SLOP: f32 = 3.;
pub(super) const ROW_PADDING: f32 = 12.;
pub(crate) const STATUS_WIDTH: f32 = 8.;
// Unknown stays a smaller dot so it reads as "no reported status" next to the full ones.
pub(super) const STATUS_DOT_UNKNOWN: f32 = 3.;
pub(crate) const LABEL_GAP: f32 = 8.;
// Children clear the gutter their tree lines run in, which starts at the
// parent's label column so the trunk lines up under the parent's branch.
pub(super) const TREE_GUTTER: f32 = ROW_PADDING + STATUS_WIDTH + LABEL_GAP;
pub(super) const CHILD_INDENT: f32 = TREE_GUTTER - ROW_PADDING + 12.;
pub(crate) const ARROW_RESERVE: f32 = 18.;
pub(crate) const HOST_ARROW_WIDTH: f32 = 12.;
pub(crate) const HOST_GAP: f32 = 6.;
pub(crate) const ICON_RESERVE: f32 = 18.;

#[cfg(any(test, feature = "integration-test"))]
pub(crate) const LABEL_WIDTH: f32 =
    SIDEBAR_WIDTH - 1. - 2. * ROW_PADDING - STATUS_WIDTH - LABEL_GAP;

pub(super) fn line_height(font: &FontConfig) -> f32 {
    font.size * 4. / 3.
}

pub(super) fn sidebar_width(preferred: Option<f32>, window_width: f32) -> f32 {
    // Keep useful label space and reserve at least 240 logical pixels for the terminal.
    preferred
        .unwrap_or(SIDEBAR_WIDTH)
        .clamp(160., 480.)
        .min((window_width - 240.).max(0.))
}

/// Sidebar labels are monospace by default and digits are near-uniform
/// elsewhere, so an em-fraction bounds a glyph well enough to divide a line.
pub(super) fn glyph_width(font: &FontConfig) -> f32 {
    font.size * 0.62
}

/// Widths in glyphs for segments sharing one line, as upstream shares them:
/// every segment keeps one glyph, then they grow in turn until the line is
/// full, so a long name cannot crowd a short one out entirely.
pub(super) fn segment_budgets(lengths: &[usize], available: usize) -> Vec<usize> {
    let mut budgets: Vec<usize> = lengths
        .iter()
        .map(|length| usize::from(*length > 0))
        .collect();
    let mut remaining = available.saturating_sub(budgets.iter().sum());
    while remaining > 0 {
        let mut grew = false;
        for (budget, length) in budgets.iter_mut().zip(lengths) {
            if *budget > 0 && *budget < *length {
                *budget += 1;
                remaining -= 1;
                grew = true;
                if remaining == 0 {
                    break;
                }
            }
        }
        if !grew {
            break;
        }
    }
    budgets
}
