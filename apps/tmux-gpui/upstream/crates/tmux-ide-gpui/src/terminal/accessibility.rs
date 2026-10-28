//! The terminal text that assistive technology reads: screen readers, and
//! selection tools that ask the focused element for its selected text
//! (`AXSelectedText` on macOS) instead of the clipboard.
//!
//! One pane or popup is exposed at a time: the one holding a selection, or,
//! without one, the popup covering the panes, else the focused pane. Each row
//! it shows becomes an AccessKit text run, read as a copy reads it: concealed
//! cells as blanks, a wide grapheme once, and no trailing padding. Only rows on
//! screen are exposed, so a selection reaching into scrollback reads its
//! visible part. The text is built while GPUI prepaints, and only while an
//! assistive client has activated accessibility.

use super::{
    InputTarget,
    selection::{self, Region, Selection},
};
use gpui::{
    A11ySubtreeBuilder,
    accesskit::{Node, NodeId, Rect, Role, TextDirection, TextPosition, TextSelection},
};
use herdr_client::protocol::{FrameData, PaneSurfaceFrame};

/// AccessKit measures each character in one byte of UTF-8 length. Terminal
/// content is untrusted and a cell's grapheme may be longer than that, so such
/// a cell reads as a replacement character instead.
const OVERLONG: &str = "\u{fffd}";

/// The cells of one painted row that read as text.
#[derive(Debug, PartialEq)]
struct Line {
    /// The grid row the line paints on.
    row: u16,
    text: String,
    /// The UTF-8 length of each character, one per grapheme.
    lengths: Vec<u8>,
    /// Each character's first column, counted from the region's first column,
    /// and the columns it covers.
    cells: Vec<(u16, u16)>,
}

impl Line {
    /// Reads `row` of `frame` within the region's columns. `None` when the
    /// frame no longer holds the row.
    fn read(frame: &FrameData, region: &Region, row: u16) -> Option<Self> {
        if row >= frame.height || region.columns.end > frame.width {
            return None;
        }
        let offset = usize::from(row) * usize::from(frame.width);
        let cells = frame.cells.get(
            offset + usize::from(region.columns.start)..offset + usize::from(region.columns.end),
        )?;
        let mut line = Self {
            row,
            text: String::new(),
            lengths: Vec::new(),
            cells: Vec::new(),
        };
        // Characters up to the last one that is not a blank: a terminal pads
        // short lines with blanks the user never typed.
        let mut kept = 0;
        for (column, span, cell) in selection::graphemes(cells) {
            let symbol = selection::shown(cell);
            let (symbol, length) = match u8::try_from(symbol.len()) {
                Ok(length) => (symbol, length),
                Err(_) => (OVERLONG, OVERLONG.len() as u8),
            };
            line.text.push_str(symbol);
            line.lengths.push(length);
            // Both fit: the region's columns are `u16`.
            line.cells.push((column as u16, span as u16));
            if !symbol.trim_end().is_empty() {
                kept = line.lengths.len();
            }
        }
        let padding: usize = line.lengths[kept..].iter().copied().map(usize::from).sum();
        line.text.truncate(line.text.len() - padding);
        line.lengths.truncate(kept);
        line.cells.truncate(kept);
        Some(line)
    }

    /// The character before which a cell edge at `column` falls. A wide
    /// grapheme counts as before an edge that cuts through it, as a copy
    /// starting on its continuation leaves it out and one ending there keeps
    /// it.
    fn character(&self, column: u16) -> usize {
        self.cells.partition_point(|&(start, _)| start < column)
    }
}

/// A position between two characters of the exposed text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Caret {
    line: usize,
    character: usize,
}

/// The exposed rows of one pane or popup, and the part of them selected.
#[derive(Debug, PartialEq)]
pub(crate) struct Transcript {
    lines: Vec<Line>,
    selection: Option<(Caret, Caret)>,
    /// The region's top-left corner, from the terminal canvas origin, and the
    /// size of a cell, in logical pixels.
    origin: (f32, f32),
    width: f32,
    cell: (f32, f32),
}

impl Transcript {
    /// Reads what the terminal shows. `None` when no pane or popup paints.
    pub(crate) fn read(
        surface: &PaneSurfaceFrame,
        selection: Option<&Selection>,
        cell_width: f32,
        cell_height: f32,
    ) -> Option<Self> {
        let selection = selection.filter(|selection| {
            selection
                .rows(surface, cell_width, cell_height)
                .next()
                .is_some()
        });
        let target = match selection {
            Some(selection) => selection.target().clone(),
            None => shown_target(surface)?,
        };
        let region = selection::region(surface, &target, cell_width, cell_height)?;
        let frame = selection::frame(surface, &target)?;
        let lines = region
            .rows
            .clone()
            .map(|row| Line::read(frame, &region, row))
            .collect::<Option<Vec<_>>>()?;
        let selection = selection.and_then(|selection| {
            let mut rows = selection.rows(surface, cell_width, cell_height);
            let first = rows.next()?;
            let last = rows.last().unwrap_or_else(|| first.clone());
            let caret = |row: u16, column: u16| {
                let line = lines.iter().position(|line| line.row == row)?;
                let character = lines[line].character(column - region.columns.start);
                Some(Caret { line, character })
            };
            Some((caret(first.0, first.1.start)?, caret(last.0, last.1.end)?))
        });
        Some(Self {
            lines,
            selection,
            origin: (
                region.origin.0 + f32::from(region.columns.start) * cell_width,
                region.origin.1,
            ),
            width: f32::from(region.columns.end - region.columns.start) * cell_width,
            cell: (cell_width, cell_height),
        })
    }

    /// Adds the rows as text runs under the terminal's node, and the selection
    /// to that node. `origin` is the terminal canvas origin in logical pixels
    /// and `scale` the window's scale factor: AccessKit bounds are in device
    /// pixels from the window's top-left corner, like the terminal node's own.
    pub(crate) fn expose(&self, builder: &mut A11ySubtreeBuilder, origin: (f32, f32), scale: f32) {
        let ids: Vec<NodeId> = (0..self.lines.len())
            .map(|line| builder.synthetic_node_id(line))
            .collect();
        for (&id, node) in ids.iter().zip(self.runs(origin, scale)) {
            builder.push_child(id, node);
        }
        if let Some(selection) = self.text_selection(&ids) {
            builder.parent_node().set_text_selection(selection);
        }
    }

    /// One text run per row. Every row but the last ends with the line break
    /// a copy puts between rows.
    fn runs(&self, origin: (f32, f32), scale: f32) -> impl Iterator<Item = Node> + '_ {
        let (cell_width, cell_height) = self.cell;
        let last = self.lines.len().saturating_sub(1);
        self.lines.iter().enumerate().map(move |(index, line)| {
            let x = (origin.0 + self.origin.0) * scale;
            let y = (origin.1 + self.origin.1 + f32::from(line.row) * cell_height) * scale;
            let mut node = Node::new(Role::TextRun);
            node.set_bounds(Rect {
                x0: f64::from(x),
                y0: f64::from(y),
                x1: f64::from(x + self.width * scale),
                y1: f64::from(y + cell_height * scale),
            });
            node.set_text_direction(TextDirection::LeftToRight);
            let mut text = line.text.clone();
            let mut lengths = line.lengths.clone();
            let mut positions: Vec<f32> = line
                .cells
                .iter()
                .map(|&(column, _)| f32::from(column) * cell_width * scale)
                .collect();
            let mut widths: Vec<f32> = line
                .cells
                .iter()
                .map(|&(_, span)| f32::from(span) * cell_width * scale)
                .collect();
            if index < last {
                // The break sits where the row's text ends and paints nothing.
                let end = line.cells.last().map_or(0, |&(column, span)| column + span);
                text.push('\n');
                lengths.push(1);
                positions.push(f32::from(end) * cell_width * scale);
                widths.push(0.);
            }
            node.set_value(text);
            node.set_character_lengths(lengths);
            node.set_character_positions(positions);
            node.set_character_widths(widths);
            node
        })
    }

    fn text_selection(&self, ids: &[NodeId]) -> Option<TextSelection> {
        let (anchor, focus) = self.selection?;
        let position = |caret: Caret| TextPosition {
            node: ids[caret.line],
            character_index: caret.character,
        };
        Some(TextSelection {
            anchor: position(anchor),
            focus: position(focus),
        })
    }
}

/// What the terminal shows without a selection: a popup covers the panes, and
/// otherwise the focused pane is the one being read and typed into.
fn shown_target(surface: &PaneSurfaceFrame) -> Option<InputTarget> {
    if let Some(popup) = &surface.popup {
        return Some(InputTarget::Popup(popup.terminal_id.clone()));
    }
    surface
        .panes
        .iter()
        .find(|pane| pane.focused)
        .or_else(|| surface.panes.first())
        .map(|pane| InputTarget::Pane(pane.pane_id.clone()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
