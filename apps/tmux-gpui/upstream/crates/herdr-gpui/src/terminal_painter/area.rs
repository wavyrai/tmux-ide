//! Which cells, and which layer of them, a paint covers.

use super::Highlight;
use herdr_client::protocol::FrameData;
use std::ops::Range;

/// Cells of one row that a paint covers, in the grid of the frame it paints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub(crate) row: u16,
    pub(crate) columns: Range<u16>,
}

/// One of the layers a paint stacks, bottom first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Layer {
    /// Cell backgrounds and highlight tints.
    Backgrounds,
    Text,
    /// Box graphics, underlines, the cursor, and scrollbars.
    Decorations,
}

impl Layer {
    pub(crate) const ALL: [Self; 3] = [Self::Backgrounds, Self::Text, Self::Decorations];
}

/// The cells and the one layer of them a paint draws. Neighbouring regions
/// paint each layer for all of them in turn, so one region's backgrounds
/// never cover a glyph that overhangs it from another.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Part<'a> {
    pub(crate) area: &'a [Span],
    pub(crate) layer: Layer,
}

/// Every cell of `frame`, row by row.
pub(super) fn whole(frame: &FrameData) -> Vec<Span> {
    (0..frame.height)
        .map(|row| Span {
            row,
            columns: 0..frame.width,
        })
        .collect()
}

/// Whether `area` covers the cell at `x`, `y`.
pub(crate) fn covers(area: &[Span], x: u16, y: u16) -> bool {
    area.iter()
        .any(|span| span.row == y && span.columns.contains(&x))
}

/// The non-empty runs of `area` inside `frame`, as ranges of its cell indices.
/// A frame short of cells paints the ones it has.
pub(crate) fn cell_ranges<'a>(
    frame: &'a FrameData,
    area: &'a [Span],
) -> impl Iterator<Item = Range<usize>> + 'a {
    let width = usize::from(frame.width);
    area.iter()
        .filter(|span| span.row < frame.height)
        .map(move |span| {
            let start = usize::from(span.row) * width;
            let end =
                |column: u16| (start + usize::from(column.min(frame.width))).min(frame.cells.len());
            end(span.columns.start)..end(span.columns.end)
        })
        .filter(|range| range.start < range.end)
}

/// The parts of `highlights` inside `area`.
pub(crate) fn clip(highlights: &[Highlight], area: &[Span]) -> Vec<Highlight> {
    highlights
        .iter()
        .flat_map(|highlight| {
            area.iter()
                .filter(move |span| span.row == highlight.row)
                .filter_map(move |span| {
                    let columns = highlight.columns.start.max(span.columns.start)
                        ..highlight.columns.end.min(span.columns.end);
                    (columns.start < columns.end).then_some(Highlight {
                        row: highlight.row,
                        columns,
                        tint: highlight.tint,
                    })
                })
        })
        .collect()
}
