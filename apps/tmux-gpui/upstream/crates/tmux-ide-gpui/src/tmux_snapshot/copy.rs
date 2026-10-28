//! Copy canonical pane cells, retaining soft-wrap metadata absent from FrameData.
use super::Error;
use crate::terminal_painter::FrameView;
#[cfg(test)]
use herdr_client::protocol::FrameData;
use serde::Deserialize;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Region {
    pub id: String,
    pub left: u16,
    pub top: u16,
    pub width: u16,
    pub height: u16,
    pub wrapped: Vec<bool>,
}
impl Region {
    #[cfg(test)]
    pub fn valid(&self, frame: &FrameData, selected: Option<&str>) -> bool {
        self.valid_view(frame.into(), selected)
    }
    pub fn valid_view(&self, frame: FrameView<'_>, selected: Option<&str>) -> bool {
        selected == Some(self.id.as_str())
            && self.width > 0
            && self.height > 0
            && u32::from(self.left) + u32::from(self.width) <= u32::from(frame.width())
            && u32::from(self.top) + u32::from(self.height) <= u32::from(frame.height())
            && self.wrapped.len() == usize::from(self.height)
    }
    #[cfg(test)]
    pub fn text(&self, frame: &FrameData) -> Result<String, Error> {
        self.text_view(frame.into())
    }
    pub fn text_view(&self, frame: FrameView<'_>) -> Result<String, Error> {
        self.text_between_view(frame, (0, 0), (self.height.saturating_sub(1), self.width))
    }
    /// Half-open pane-relative cell boundaries. Keep intersected graphemes whole.
    #[cfg(test)]
    pub fn text_between(
        &self,
        frame: &FrameData,
        anchor: (u16, u16),
        head: (u16, u16),
    ) -> Result<String, Error> {
        self.text_between_view(frame.into(), anchor, head)
    }
    pub fn text_between_view(
        &self,
        frame: FrameView<'_>,
        anchor: (u16, u16),
        head: (u16, u16),
    ) -> Result<String, Error> {
        let mut text = String::new();
        let last_row = anchor.0.max(head.0);
        for (row, columns) in self.spans_view(frame, anchor, head)? {
            let cells = self.row(frame, row)?;
            let left = columns.start;
            let right = columns.end;
            let mut line = String::new();
            for cell in &cells[left..right] {
                if cell.skip {
                    continue;
                }
                let symbol =
                    if cell.modifier & crate::terminal::HIDDEN != 0 || cell.symbol.is_empty() {
                        " "
                    } else {
                        &cell.symbol
                    };
                if text.len() + line.len() + symbol.len() > crate::terminal::MAX_SELECTION_BYTES {
                    return Err(Error::Invalid("copy exceeds 4 MiB"));
                }
                line.push_str(symbol);
            }
            // Canonical wrapped marks continuation FROM the previous row. The
            // next row therefore decides whether this boundary is a soft wrap.
            let wrapped = self
                .wrapped
                .get(usize::from(row) + 1)
                .copied()
                .unwrap_or(false);
            text.push_str(if wrapped || right < cells.len() {
                &line
            } else {
                line.trim_end_matches(' ')
            });
            if row < last_row && !wrapped {
                if text.len() == crate::terminal::MAX_SELECTION_BYTES {
                    return Err(Error::Invalid("copy exceeds 4 MiB"));
                }
                text.push('\n');
            }
        }
        Ok(text)
    }
    pub fn spans_view(
        &self,
        frame: FrameView<'_>,
        anchor: (u16, u16),
        head: (u16, u16),
    ) -> Result<Vec<(u16, std::ops::Range<usize>)>, Error> {
        if !self.valid_view(frame, Some(&self.id)) {
            return Err(Error::Invalid("invalid copy region"));
        }
        if [anchor, head]
            .iter()
            .any(|&(row, column)| row >= self.height || column > self.width)
        {
            return Err(Error::Invalid("invalid selection boundary"));
        }
        if anchor == head {
            return Ok(Vec::new());
        }
        let (first, last) = if anchor < head {
            (anchor, head)
        } else {
            (head, anchor)
        };
        let mut spans = Vec::new();
        for row in first.0..=last.0 {
            let cells = self.row(frame, row)?;
            let mut left = if row == first.0 {
                usize::from(first.1)
            } else {
                0
            };
            let mut right = if row == last.0 {
                usize::from(last.1)
            } else {
                cells.len()
            };
            if left < right {
                while left > 0 && cells.get(left).is_some_and(|cell| cell.skip) {
                    left -= 1;
                }
                while right < cells.len() && cells[right].skip {
                    right += 1;
                }
            }
            spans.push((row, left..right));
        }
        Ok(spans)
    }
    fn row<'a>(
        &self,
        frame: FrameView<'a>,
        row: u16,
    ) -> Result<&'a [herdr_client::protocol::CellData], Error> {
        let start = usize::from(self.left);
        frame
            .row(usize::from(self.top) + usize::from(row))
            .and_then(|cells| cells.get(start..start + usize::from(self.width)))
            .ok_or(Error::Invalid("missing copy cells"))
    }
}
#[cfg(test)]
#[path = "copy_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "copy_row_tests.rs"]
mod row_tests;
