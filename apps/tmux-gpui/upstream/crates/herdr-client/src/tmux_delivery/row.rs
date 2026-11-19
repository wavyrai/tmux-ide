//! A terminal row stored compactly: its graphemes as one string and its
//! styles as runs. A history of 10,000 rows is held per pane, so a row costs
//! about one byte per cell of plain text plus 12 bytes per style change,
//! instead of a 40-byte cell and a grapheme allocation per cell.
use super::types::{Cell, Color};
use std::sync::Arc;

/// Cells `..end` (after the previous run's end) share width, colours and
/// attributes. Colours are packed as on the painter's wire: 0 default,
/// `0x01000000 | index`, `0x02000000 | rgb`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Run {
    end: u16,
    width: u8,
    attributes: u8,
    foreground: u32,
    background: u32,
}

/// One cell of a [`Row`], borrowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellRef<'a> {
    pub grapheme: &'a str,
    pub width: u8,
    pub foreground: Color,
    pub background: Color,
    pub attributes: u8,
}
impl CellRef<'_> {
    pub fn to_cell(&self) -> Cell {
        Cell {
            grapheme: Arc::from(self.grapheme),
            width: self.width,
            foreground: self.foreground,
            background: self.background,
            attributes: self.attributes,
        }
    }
}

/// Cells and their cached digest cannot be mutated after validation.
#[derive(Debug, PartialEq, Eq)]
pub struct Row {
    /// Every cell's grapheme, in order.
    text: Box<str>,
    /// Where each cell's grapheme ends in `text`. `None` when every cell of
    /// width 0 has an empty grapheme and every other cell exactly one char,
    /// as almost every row does.
    ends: Option<Box<[u32]>>,
    runs: Box<[Run]>,
    wrapped: bool,
    digest: u64,
}
impl Row {
    pub fn cells(&self) -> Cells<'_> {
        Cells {
            row: self,
            cell: 0,
            run: 0,
            at: 0,
        }
    }
    /// The number of cells.
    pub fn len(&self) -> usize {
        self.runs.last().map_or(0, |run| usize::from(run.end))
    }
    pub fn is_empty(&self) -> bool {
        self.runs.is_empty()
    }
    pub fn wrapped(&self) -> bool {
        self.wrapped
    }
    pub fn digest(&self) -> u64 {
        self.digest
    }
    /// Heap bytes this row holds, with its `Arc`: what a scrollback of it costs.
    pub fn heap_bytes(&self) -> usize {
        size_of::<Row>()
            + 2 * size_of::<usize>()
            + self.text.len()
            + self.ends.as_ref().map_or(0, |e| e.len() * size_of::<u32>())
            + self.runs.len() * size_of::<Run>()
    }
    pub(crate) fn new(cells: Vec<Cell>, wrapped: bool) -> Self {
        let mut builder = Builder::default();
        for cell in &cells {
            builder.push(
                1,
                &cell.grapheme,
                cell.width,
                &cell.foreground,
                &cell.background,
                cell.attributes,
            );
        }
        builder.finish(wrapped)
    }
}

/// Builds a [`Row`] from runs of equal cells, as the wire sends them.
#[derive(Default)]
pub(super) struct Builder {
    text: String,
    ends: Option<Vec<u32>>,
    runs: Vec<Run>,
    cells: usize,
}
impl Builder {
    pub fn len(&self) -> usize {
        self.cells
    }
    /// Appends `count` cells. The caller bounds `count` and the row's length
    /// (at most 4096 cells) and checks wide-cell pairing with [`Self::paired`].
    pub fn push(
        &mut self,
        count: usize,
        grapheme: &str,
        width: u8,
        foreground: &Color,
        background: &Color,
        attributes: u8,
    ) {
        if count == 0 {
            return;
        }
        let simple = if width == 0 {
            grapheme.is_empty()
        } else {
            let mut chars = grapheme.chars();
            chars.next().is_some() && chars.next().is_none()
        };
        if !simple && self.ends.is_none() {
            self.ends = Some(self.backfill());
        }
        for _ in 0..count {
            self.text.push_str(grapheme);
            if let Some(ends) = &mut self.ends {
                ends.push(u32::try_from(self.text.len()).unwrap_or(u32::MAX));
            }
        }
        self.cells += count;
        let end = u16::try_from(self.cells).unwrap_or(u16::MAX);
        let run = Run {
            end,
            width,
            attributes,
            foreground: pack(foreground),
            background: pack(background),
        };
        match self.runs.last_mut() {
            Some(last)
                if Run {
                    end: last.end,
                    ..run
                } == *last =>
            {
                last.end = end;
            }
            _ => self.runs.push(run),
        }
    }
    /// Every cell of width 2 is followed by one of width 0, and every cell of
    /// width 0 follows one of width 2.
    pub fn paired(&self) -> bool {
        let mut previous = None;
        let mut start = 0;
        for run in &self.runs {
            for _ in start..usize::from(run.end) {
                match (previous, run.width) {
                    (Some(2), w) if w != 0 => return false,
                    (p, 0) if p != Some(2) => return false,
                    _ => {}
                }
                previous = Some(run.width);
            }
            start = usize::from(run.end);
        }
        previous != Some(2)
    }
    /// The grapheme ends of the cells pushed so far, all simple.
    fn backfill(&self) -> Vec<u32> {
        let mut ends = Vec::with_capacity(self.cells + 1);
        let mut chars = self.text.char_indices();
        let mut start = 0;
        for run in &self.runs {
            for _ in start..usize::from(run.end) {
                let end = if run.width == 0 {
                    ends.last().copied().unwrap_or(0)
                } else {
                    chars.next().map_or(0, |(at, c)| (at + c.len_utf8()) as u32)
                };
                ends.push(end);
            }
            start = usize::from(run.end);
        }
        ends
    }
    pub fn finish(self, wrapped: bool) -> Row {
        let mut row = Row {
            text: self.text.into_boxed_str(),
            ends: self.ends.map(Vec::into_boxed_slice),
            runs: self.runs.into_boxed_slice(),
            wrapped,
            digest: 0,
        };
        row.digest = super::hash::hash_row(row.cells(), wrapped);
        row
    }
}

fn pack(color: &Color) -> u32 {
    match color {
        Color::Default => 0,
        Color::Indexed { index } => 0x0100_0000 | u32::from(*index),
        // Both decoders bound RGB to 24 bits.
        Color::Rgb { value } => 0x0200_0000 | (value & 0x00ff_ffff),
    }
}
fn unpack(color: u32) -> Color {
    match color >> 24 {
        0 => Color::Default,
        1 => Color::Indexed { index: color as u8 },
        _ => Color::Rgb {
            value: color & 0x00ff_ffff,
        },
    }
}

/// A row's cells in order.
#[derive(Clone)]
pub struct Cells<'a> {
    row: &'a Row,
    cell: usize,
    run: usize,
    /// Where the next simple cell's grapheme starts in `text`.
    at: usize,
}
impl<'a> Iterator for Cells<'a> {
    type Item = CellRef<'a>;
    fn next(&mut self) -> Option<CellRef<'a>> {
        let row = self.row;
        let mut run = row.runs.get(self.run)?;
        if self.cell >= usize::from(run.end) {
            self.run += 1;
            run = row.runs.get(self.run)?;
        }
        let grapheme = match &row.ends {
            Some(ends) => {
                let start = match self.cell {
                    0 => 0,
                    n => ends[n - 1] as usize,
                };
                &row.text[start..ends[self.cell] as usize]
            }
            None if run.width == 0 => "",
            None => {
                let len = row.text[self.at..].chars().next().map_or(0, char::len_utf8);
                let grapheme = &row.text[self.at..self.at + len];
                self.at += len;
                grapheme
            }
        };
        self.cell += 1;
        Some(CellRef {
            grapheme,
            width: run.width,
            foreground: unpack(run.foreground),
            background: unpack(run.background),
            attributes: run.attributes,
        })
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        let left = self.row.len() - self.cell;
        (left, Some(left))
    }
}
impl ExactSizeIterator for Cells<'_> {}

#[cfg(test)]
#[path = "row_tests.rs"]
mod tests;
