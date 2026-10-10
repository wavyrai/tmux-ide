//! Selecting painted cells with the pointer, and the text a release copies.
//!
//! Selection is client-local: the daemon owns the terminal, and nothing here
//! sends input to it. Columns are addressed in the grid of the frame that
//! paints them, so a pane selection never leaves its inner rect and a popup
//! selection never reaches the panes underneath it. Rows are content rows: a
//! pane's absolute screen-buffer row (the one `pane.selection.read` takes),
//! which stays with its text while the pane scrolls, and a popup's own grid
//! row. A selection that reaches rows the pane no longer shows is read back
//! from the daemon instead of from the painted cells.

use super::{HIDDEN, InputTarget, popup_origin, wheel_target};
use crate::error::{Error, Result};
use herdr_client::{
    protocol::{CellData, FrameData, PaneSurfaceFrame},
    scrollback::{TextPoint, TextRange},
};
use std::ops::Range;
use unicode_width::UnicodeWidthStr;

/// Terminal content is untrusted and one cell's symbol carries as many bytes as
/// it likes, so a copy is bounded rather than trusted to be screen-sized.
pub(crate) const MAX_SELECTION_BYTES: usize = 4 << 20;

/// Which half of a cell the pointer sat in. Anchoring on the half, as terminal
/// emulators do, is what makes a single cell selectable while a plain click,
/// which never leaves the half it started in, selects nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Side {
    Left,
    Right,
}

/// A pointer position on the cell grid. Ordered by reading order, so the two
/// ends of a drag sort into a start and an end whichever way it was made.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Edge {
    /// A content row; see the module documentation.
    row: u32,
    column: u16,
    side: Side,
}

/// The cells one target owns, in its own frame's grid, and where that grid is
/// painted relative to the canvas origin. `top` is the content row painted on
/// the grid's first row.
pub(super) struct Region {
    pub(super) columns: Range<u16>,
    pub(super) rows: Range<u16>,
    pub(super) origin: (f32, f32),
    top: u32,
}

impl Region {
    fn content_row(&self, row: u16) -> u32 {
        self.top.saturating_add(u32::from(row - self.rows.start))
    }

    /// The grid row a content row paints on, when it is on screen.
    fn grid_row(&self, row: u32) -> Option<u16> {
        let offset = u16::try_from(row.checked_sub(self.top)?).ok()?;
        let row = self.rows.start.checked_add(offset)?;
        self.rows.contains(&row).then_some(row)
    }

    fn shows(&self, row: u32) -> bool {
        self.grid_row(row).is_some()
    }

    /// The cell edge under a pointer, clamped into the region so that dragging
    /// out of it selects up to its boundary instead of ending the gesture.
    fn edge(&self, x: f32, y: f32, cell_width: f32, cell_height: f32) -> Option<Edge> {
        if !x.is_finite()
            || !y.is_finite()
            || !cell_width.is_finite()
            || !cell_height.is_finite()
            || cell_width <= 0.
            || cell_height <= 0.
            || self.columns.is_empty()
            || self.rows.is_empty()
        {
            return None;
        }
        let (last_row, last_column) = (self.rows.end - 1, self.columns.end - 1);
        let row = ((y - self.origin.1) / cell_height).floor();
        if row < f32::from(self.rows.start) {
            return Some(Edge {
                row: self.top,
                column: self.columns.start,
                side: Side::Left,
            });
        }
        if row > f32::from(last_row) {
            return Some(Edge {
                row: self.content_row(last_row),
                column: last_column,
                side: Side::Right,
            });
        }
        let row = self.content_row(row as u16);
        let column = (x - self.origin.0) / cell_width;
        if column < f32::from(self.columns.start) {
            return Some(Edge {
                row,
                column: self.columns.start,
                side: Side::Left,
            });
        }
        if column >= f32::from(self.columns.end) {
            return Some(Edge {
                row,
                column: last_column,
                side: Side::Right,
            });
        }
        Some(Edge {
            row,
            column: column.floor() as u16,
            side: if column.fract() < 0.5 {
                Side::Left
            } else {
                Side::Right
            },
        })
    }
}

/// Share popup isolation and pane bounds with input and link resolution.
pub(super) fn region(
    surface: &PaneSurfaceFrame,
    target: &InputTarget,
    cell_width: f32,
    cell_height: f32,
) -> Option<Region> {
    match target {
        InputTarget::Popup(terminal_id) => {
            let popup = surface
                .popup
                .as_ref()
                .filter(|popup| popup.terminal_id == *terminal_id)?;
            let origin = popup_origin(&surface.frame, &popup.frame, cell_width, cell_height);
            Some(Region {
                columns: 0..popup.frame.width,
                rows: 0..popup.frame.height,
                origin: (f32::from(origin.x), f32::from(origin.y)),
                top: 0,
            })
        }
        // A popup covers the panes: what was selected under it is off screen.
        InputTarget::Pane(_) if surface.popup.is_some() => None,
        InputTarget::Pane(pane_id) => {
            let pane = surface.panes.iter().find(|pane| pane.pane_id == *pane_id)?;
            let rect = pane.inner_rect;
            Some(Region {
                columns: rect.x..rect.x.saturating_add(rect.width),
                rows: rect.y..rect.y.saturating_add(rect.height),
                origin: (0., 0.),
                top: crate::scrollback::viewport_top(pane),
            })
        }
    }
}

/// The frame whose grid a target's cells are addressed in.
pub(super) fn frame<'a>(
    surface: &'a PaneSurfaceFrame,
    target: &InputTarget,
) -> Option<&'a FrameData> {
    match target {
        InputTarget::Popup(_) => surface.popup.as_ref().map(|popup| &popup.frame),
        InputTarget::Pane(_) => Some(&surface.frame),
    }
}

/// How much one press takes: the half-cell under it for a single click, the
/// link or word for a double click, and the whole row for a triple click. A
/// drag that follows grows the selection by the same unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unit {
    Cell,
    Word,
    Line,
}

impl From<usize> for Unit {
    fn from(clicks: usize) -> Self {
        match clicks {
            0 | 1 => Self::Cell,
            2 => Self::Word,
            _ => Self::Line,
        }
    }
}

impl Unit {
    /// The first and last edge of the unit around `edge`.
    fn span(self, frame: &FrameData, region: &Region, edge: Edge) -> (Edge, Edge) {
        let row = |columns: Range<u16>| {
            (
                Edge {
                    row: edge.row,
                    column: columns.start,
                    side: Side::Left,
                },
                Edge {
                    row: edge.row,
                    column: columns.end - 1,
                    side: Side::Right,
                },
            )
        };
        match self {
            Self::Cell => (edge, edge),
            Self::Line => row(region.columns.clone()),
            Self::Word => row(region
                .grid_row(edge.row)
                .and_then(|grid| word(frame, region, grid, edge.column))
                .unwrap_or(edge.column..edge.column + 1)),
        }
    }
}

/// The columns of the unbroken run of cells around `hit` that belong, where
/// cells are indexed from the region's first column.
fn run(start: u16, hit: usize, len: usize, belongs: &impl Fn(usize) -> bool) -> Range<u16> {
    let first = (0..hit)
        .rev()
        .take_while(|&i| belongs(i))
        .last()
        .unwrap_or(hit);
    let last = (hit + 1..len)
        .take_while(|&i| belongs(i))
        .last()
        .unwrap_or(hit);
    let at = |index: usize| start + index as u16;
    at(first)..at(last) + 1
}

/// Characters that end a word even though they are printed: quotes, brackets,
/// and the separators and borders that sit between words in terminal output.
pub(super) fn separates(c: char) -> bool {
    c.is_whitespace()
        || c.is_control()
        || matches!(
            c,
            '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '|' | ',' | ';'
        )
        || ('\u{2500}'..='\u{259f}').contains(&c)
}

/// What a cell reads as: concealed cells read as blanks, never their hidden
/// text, and an empty cell as the blank a terminal paints.
pub(super) fn shown(cell: &CellData) -> &str {
    if cell.modifier & HIDDEN != 0 || cell.symbol.is_empty() {
        " "
    } else {
        cell.symbol.as_str()
    }
}

/// The cells of one row that read as text, each with its column, counted from
/// the first cell, and the columns it spans. The wire skip flag is not a
/// wide-cell marker: continuation cells can be ordinary blanks, so a wide
/// grapheme covers the cells its width takes, and the scan starts at the
/// row's first cell so a range starting on a continuation recognizes it too.
pub(super) fn graphemes(cells: &[CellData]) -> impl Iterator<Item = (usize, usize, &CellData)> {
    let mut covered = 0;
    cells.iter().enumerate().filter_map(move |(column, cell)| {
        if column < covered || cell.skip {
            return None;
        }
        let span = cell.symbol.width().max(1).min(cells.len() - column);
        covered = column + span;
        Some((column, span, cell))
    })
}

/// The columns of the word a double click at `column` chooses. An explicit
/// hyperlink takes its whole run of cells and a plain web URL its whole
/// destination; otherwise the word runs to the nearest separator, so paths
/// such as `src/main.rs:12` come out whole, without the punctuation that ends
/// a sentence after them. `None` when the click is not on a word.
fn word(frame: &FrameData, region: &Region, row: u16, column: u16) -> Option<Range<u16>> {
    let Region { columns, .. } = region;
    if row >= frame.height || columns.end > frame.width || !columns.contains(&column) {
        return None;
    }
    let offset = usize::from(row) * usize::from(frame.width);
    let cells = frame
        .cells
        .get(offset + usize::from(columns.start)..offset + usize::from(columns.end))?;
    // A wide character's continuation cells belong to the cell that drew it.
    let source = |index: usize| (0..=index).rev().find(|&i| !cells[i].skip).unwrap_or(index);
    let hit = source(usize::from(column - columns.start));
    if let Some(link) = cells[hit].hyperlink {
        return Some(run(columns.start, hit, cells.len(), &|i| {
            cells[i].skip || cells[i].hyperlink == Some(link)
        }));
    }

    // Byte offsets into the row's text, so a plain URL maps back to columns.
    let mut text = String::new();
    let mut starts = Vec::with_capacity(cells.len());
    for cell in cells {
        starts.push(text.len());
        if cell.skip {
            continue;
        }
        let symbol = shown(cell);
        if text.len() + symbol.len() > super::links::MAX_ROW_BYTES {
            return None;
        }
        text.push_str(symbol);
    }
    if let Some((range, _)) = super::links::plain_url(&text, starts[hit]) {
        return Some(run(columns.start, hit, cells.len(), &|i| {
            range.contains(&starts[source(i)])
        }));
    }

    let first_char = |index: usize| shown(&cells[source(index)]).chars().next().unwrap_or(' ');
    if separates(first_char(hit)) {
        return None;
    }
    let mut span = run(columns.start, hit, cells.len(), &|i| {
        !separates(first_char(i))
    });
    // Punctuation closing a sentence is not part of the word before it, unless
    // it is what was clicked.
    while span.end - 1 > column
        && matches!(
            first_char(usize::from(span.end - 1 - columns.start)),
            '.' | ':' | '!' | '?'
        )
    {
        span.end -= 1;
    }
    Some(span)
}

/// Cells the pointer has chosen in one pane or popup. The region is resolved
/// against the surface on every use, so a pane that shrank, closed, or was
/// covered by a popup neither paints nor copies stale cells.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Selection {
    target: InputTarget,
    unit: Unit,
    /// The unit the press chose, which the selection always keeps.
    origin: (Edge, Edge),
    anchor: Edge,
    head: Edge,
    dragging: bool,
}

impl Selection {
    /// Starts a drag at the pointer, or `None` where no pane or popup paints.
    /// `clicks` is the press's click count: a double click starts on the word
    /// under the pointer and a triple click on its row.
    pub(crate) fn begin(
        surface: &PaneSurfaceFrame,
        x: f32,
        y: f32,
        cell_width: f32,
        cell_height: f32,
        clicks: usize,
    ) -> Option<Self> {
        let target = wheel_target(surface, x, y, cell_width, cell_height)?.target;
        let region = region(surface, &target, cell_width, cell_height)?;
        let edge = region.edge(x, y, cell_width, cell_height)?;
        let unit = Unit::from(clicks);
        let origin = unit.span(frame(surface, &target)?, &region, edge);
        Some(Self {
            target,
            unit,
            origin,
            anchor: origin.0,
            head: origin.1,
            dragging: true,
        })
    }

    pub(crate) fn dragging(&self) -> bool {
        self.dragging
    }

    /// Follows the pointer. `false` when nothing about the selection changed.
    pub(crate) fn extend(
        &mut self,
        surface: &PaneSurfaceFrame,
        x: f32,
        y: f32,
        cell_width: f32,
        cell_height: f32,
    ) -> bool {
        let Some(region) = region(surface, &self.target, cell_width, cell_height) else {
            return false;
        };
        let (Some(edge), Some(frame)) = (
            region.edge(x, y, cell_width, cell_height),
            frame(surface, &self.target),
        ) else {
            return false;
        };
        let (start, end) = self.unit.span(frame, &region, edge);
        // Dragging back before the unit the press chose keeps its far end, so
        // the selection never loses what the press took.
        let ends = if start < self.origin.0 {
            (self.origin.1, start)
        } else {
            (self.origin.0, end.max(self.origin.1))
        };
        let changed = (self.anchor, self.head) != ends;
        (self.anchor, self.head) = ends;
        changed
    }

    /// Ends the drag. `false` when the gesture had already finished.
    pub(crate) fn release(&mut self) -> bool {
        std::mem::replace(&mut self.dragging, false)
    }

    /// The pane or popup the selection is in.
    pub(super) fn target(&self) -> &InputTarget {
        &self.target
    }

    /// The pane a pane selection belongs to.
    pub(crate) fn pane_id(&self) -> Option<&str> {
        match &self.target {
            InputTarget::Pane(id) => Some(id),
            InputTarget::Popup(_) => None,
        }
    }

    /// True for a selection that paints on the composite frame of the panes.
    pub(crate) fn in_panes(&self) -> bool {
        matches!(self.target, InputTarget::Pane(_))
    }

    /// True for a selection that paints on this popup's own frame.
    pub(crate) fn in_popup(&self, terminal_id: &str) -> bool {
        matches!(&self.target, InputTarget::Popup(id) if id == terminal_id)
    }

    /// The selected cells of each row, in the grid of the frame that paints
    /// them. Empty while the pointer has not left the half-cell it started in.
    pub(crate) fn rows(
        &self,
        surface: &PaneSurfaceFrame,
        cell_width: f32,
        cell_height: f32,
    ) -> impl Iterator<Item = (u16, Range<u16>)> {
        region(surface, &self.target, cell_width, cell_height)
            .into_iter()
            .flat_map(|region| self.spans(region))
    }

    fn ends(&self) -> (Edge, Edge) {
        if self.anchor <= self.head {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    /// The selected cells of each content row the region shows, in its grid.
    fn spans(&self, region: Region) -> impl Iterator<Item = (u16, Range<u16>)> {
        let (start, end) = self.ends();
        let columns = region.columns.clone();
        let bottom = region.content_row(region.rows.end.saturating_sub(1));
        let last = end.row.min(bottom);
        let mut next = Some(start.row.max(region.top)).filter(|_| !region.rows.is_empty());
        std::iter::from_fn(move || {
            while let Some(row) = next.filter(|row| *row <= last) {
                next = row.checked_add(1);
                // The ends cut their own row at the pointer; the rows between
                // them run the full width of the region.
                let edge = |edge: Edge| match edge.side {
                    Side::Left => edge.column,
                    Side::Right => edge.column.saturating_add(1),
                };
                let first = if row == start.row {
                    edge(start).max(columns.start)
                } else {
                    columns.start
                };
                let stop = if row == end.row {
                    edge(end).min(columns.end)
                } else {
                    columns.end
                };
                if first < stop
                    && let Some(grid) = region.grid_row(row)
                {
                    return Some((grid, first..stop));
                }
            }
            None
        })
    }

    /// The pane and inclusive cell range to read from the daemon, for a pane
    /// selection that reaches rows the pane does not show; `None` when the
    /// painted cells hold all of it, or when it chose no cell.
    pub(crate) fn offscreen_range(
        &self,
        surface: &PaneSurfaceFrame,
        cell_width: f32,
        cell_height: f32,
    ) -> Option<(&str, TextRange)> {
        let InputTarget::Pane(pane_id) = &self.target else {
            return None;
        };
        let region = region(surface, &self.target, cell_width, cell_height)?;
        let (start, end) = self.ends();
        if region.shows(start.row) && region.shows(end.row) {
            return None;
        }
        let Region { columns, .. } = region;
        let last = columns.end.checked_sub(1)?;
        // Edges sit between cells: a right edge takes its cell's successor at
        // the start, a left edge its predecessor at the end.
        let first = match start.side {
            Side::Left => TextPoint {
                row: start.row,
                col: start.column,
            },
            Side::Right if start.column < last => TextPoint {
                row: start.row,
                col: start.column + 1,
            },
            Side::Right => TextPoint {
                row: start.row.checked_add(1)?,
                col: columns.start,
            },
        };
        let stop = match end.side {
            Side::Right => TextPoint {
                row: end.row,
                col: end.column,
            },
            Side::Left if end.column > columns.start => TextPoint {
                row: end.row,
                col: end.column - 1,
            },
            Side::Left => TextPoint {
                row: end.row.checked_sub(1)?,
                col: last,
            },
        };
        if stop < first {
            return None;
        }
        // The daemon counts columns from the pane's own left edge.
        let local = |point: TextPoint| TextPoint {
            col: point.col - columns.start,
            ..point
        };
        Some((
            pane_id,
            TextRange {
                start: local(first),
                end: local(stop),
            },
        ))
    }

    /// The selected text, with rows separated by a newline. Padding is trimmed
    /// from rows selected through to the region's right edge, where a terminal
    /// pads short lines with blanks the user never typed.
    pub(crate) fn text(
        &self,
        surface: &PaneSurfaceFrame,
        cell_width: f32,
        cell_height: f32,
    ) -> Result<String> {
        let region =
            region(surface, &self.target, cell_width, cell_height).ok_or(Error::SelectionStale)?;
        let frame = frame(surface, &self.target).ok_or(Error::SelectionStale)?;
        let (start, end) = self.ends();
        if !region.shows(start.row) || !region.shows(end.row) {
            return Err(Error::SelectionOffscreen);
        }
        let edge = region.columns.end;
        let left = region.columns.start;
        let mut text = String::new();
        let mut line = String::new();
        for (index, (row, columns)) in self.spans(region).enumerate() {
            if row >= frame.height {
                return Err(Error::SelectionStale);
            }
            let offset = usize::from(row) * usize::from(frame.width);
            let cells = frame
                .cells
                .get(offset + usize::from(left)..offset + usize::from(columns.end))
                .ok_or(Error::SelectionStale)?;
            if index > 0 {
                text.push('\n');
            }
            line.clear();
            for (column, _, cell) in graphemes(cells) {
                if cell.symbol.len() > MAX_SELECTION_BYTES {
                    return Err(Error::SelectionSize);
                }
                if column < usize::from(columns.start - left) {
                    continue;
                }
                let symbol = shown(cell);
                if text.len() + line.len() + symbol.len() > MAX_SELECTION_BYTES {
                    return Err(Error::SelectionSize);
                }
                line.push_str(symbol);
            }
            text.push_str(if columns.end >= edge {
                line.trim_end()
            } else {
                &line
            });
        }
        Ok(text)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
