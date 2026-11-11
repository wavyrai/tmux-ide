//! Word and line boundaries for double- and triple-click, as the terminal
//! app draws them: letters, digits, marks and `_` make a word; a run of
//! spaces or of punctuation is its own unit; soft-wrapped rows join.
use super::super::{Error, copy};
use super::Unit;
use crate::terminal_painter::FrameView;
use herdr_client::protocol::CellData;

/// A selection boundary: (row, column), the column half-open.
pub(super) type Boundary = (u16, u16);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Word,
    Space,
    Punctuation,
}

fn kind(cell: &CellData) -> Kind {
    let symbol = if cell.symbol.is_empty() {
        " "
    } else {
        cell.symbol.as_str()
    };
    if symbol
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || unicode_mark(c))
    {
        Kind::Word
    } else if symbol.chars().all(char::is_whitespace) {
        Kind::Space
    } else {
        Kind::Punctuation
    }
}

/// Combining marks keep their base character's word.
fn unicode_mark(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036f | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff | 0x20d0..=0x20ff | 0xfe20..=0xfe2f)
}

/// Half-open boundaries (row, column) of the `unit` holding `cell`.
pub(super) fn bounds(
    region: &copy::Region,
    frame: FrameView<'_>,
    unit: Unit,
    cell: (u16, u16),
) -> Result<(Boundary, Boundary), Error> {
    if !region.valid_view(frame, Some(&region.id))
        || cell.0 >= region.height
        || cell.1 >= region.width
    {
        return Err(Error::Invalid("selection unit outside the pane"));
    }
    // A row continues the one above when it is soft-wrapped.
    let joins = |row: u16| {
        region
            .wrapped
            .get(usize::from(row))
            .copied()
            .unwrap_or(false)
    };
    if unit == Unit::Line {
        let (mut first, mut last) = (cell.0, cell.0);
        while first > 0 && joins(first) {
            first -= 1;
        }
        while last + 1 < region.height && joins(last + 1) {
            last += 1;
        }
        return Ok(((first, 0), (last, region.width)));
    }
    let row = |r: u16| -> Result<&[CellData], Error> {
        let start = usize::from(region.left);
        frame
            .row(usize::from(region.top + r))
            .and_then(|cells| cells.get(start..start + usize::from(region.width)))
            .ok_or(Error::Invalid("missing selection cells"))
    };
    let at = |(r, c): (u16, u16)| -> Result<&CellData, Error> {
        row(r)?
            .get(usize::from(c))
            .ok_or(Error::Invalid("missing selection cell"))
    };
    // A wide character's padding cell belongs to it.
    let owner = |(r, c): (u16, u16)| -> Result<(u16, u16), Error> {
        Ok(if c > 0 && at((r, c))?.skip {
            (r, c - 1)
        } else {
            (r, c)
        })
    };
    let start_cell = owner(cell)?;
    let wanted = kind(at(start_cell)?);
    let mut start = start_cell;
    loop {
        let previous = if start.1 > 0 {
            (start.0, start.1 - 1)
        } else if start.0 > 0 && joins(start.0) {
            (start.0 - 1, region.width - 1)
        } else {
            break;
        };
        let previous = owner(previous)?;
        if kind(at(previous)?) != wanted {
            break;
        }
        start = previous;
    }
    let mut end = start_cell;
    loop {
        // Past this cell and any padding after it.
        let mut column = end.1 + 1;
        while column < region.width && at((end.0, column))?.skip {
            column += 1;
        }
        let next = if column < region.width {
            (end.0, column)
        } else if end.0 + 1 < region.height && joins(end.0 + 1) {
            (end.0 + 1, 0)
        } else {
            break;
        };
        if kind(at(next)?) != wanted {
            break;
        }
        end = next;
    }
    let mut stop = end.1 + 1;
    while stop < region.width && at((end.0, stop))?.skip {
        stop += 1;
    }
    Ok((start, (end.0, stop)))
}
