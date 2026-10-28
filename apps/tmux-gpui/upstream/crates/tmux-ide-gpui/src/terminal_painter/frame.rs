//! Borrowed painter access to legacy wire frames and native immutable rows.
use herdr_client::protocol::{CellData, CursorState, FrameData};
use std::sync::Arc;

/// Native presentation state; this is not part of the Herdr wire protocol.
#[derive(Debug)]
pub(crate) struct NativeFrame {
    pub rows: Vec<Arc<[CellData]>>,
    pub width: u16,
    pub height: u16,
    pub cursor: Option<CursorState>,
}
impl NativeFrame {
    #[cfg(test)]
    pub fn cell(&self, x: usize, y: usize) -> Option<&CellData> {
        FrameView::Rows(self).cell(x, y)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum FrameView<'a> {
    Flat(&'a FrameData),
    Rows(&'a NativeFrame),
}
impl<'a> From<&'a FrameData> for FrameView<'a> {
    fn from(frame: &'a FrameData) -> Self {
        Self::Flat(frame)
    }
}
impl<'a> From<&'a NativeFrame> for FrameView<'a> {
    fn from(frame: &'a NativeFrame) -> Self {
        Self::Rows(frame)
    }
}
impl<'a> FrameView<'a> {
    pub fn width(self) -> u16 {
        match self {
            Self::Flat(f) => f.width,
            Self::Rows(f) => f.width,
        }
    }
    pub fn height(self) -> u16 {
        match self {
            Self::Flat(f) => f.height,
            Self::Rows(f) => f.height,
        }
    }
    pub fn cursor(self) -> Option<&'a CursorState> {
        match self {
            Self::Flat(f) => f.cursor.as_ref(),
            Self::Rows(f) => f.cursor.as_ref(),
        }
    }
    pub fn has_inline_graphics(self) -> bool {
        match self {
            Self::Flat(frame) => !frame.graphics.is_empty(),
            Self::Rows(_) => false,
        }
    }
    pub fn hyperlinks(self) -> &'a [String] {
        match self {
            Self::Flat(frame) => &frame.hyperlinks,
            Self::Rows(_) => &[],
        }
    }
    /// Bounds every row independently, including malformed/truncated flat frames.
    pub fn row(self, y: usize) -> Option<&'a [CellData]> {
        if y >= usize::from(self.height()) {
            return None;
        }
        let width = usize::from(self.width());
        match self {
            Self::Flat(frame) => {
                let start = y * width;
                frame
                    .cells
                    .get(start..(start + width).min(frame.cells.len()))
            }
            Self::Rows(frame) => frame.rows.get(y).map(|row| &row[..row.len().min(width)]),
        }
    }
    pub fn cell(self, x: usize, y: usize) -> Option<&'a CellData> {
        self.row(y)?.get(x)
    }
    pub fn cell_at(self, index: usize) -> Option<&'a CellData> {
        let width = usize::from(self.width());
        if width == 0 {
            return None;
        }
        self.cell(index % width, index / width)
    }
}
