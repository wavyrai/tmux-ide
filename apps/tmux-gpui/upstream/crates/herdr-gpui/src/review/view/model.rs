//! Where things are in the diff's list. Each file takes a header, then its
//! lines, unified or paired side by side, or one line standing in for them
//! while they are unread, binary or too large; a folded file only its
//! header. Reading or folding a file splices its rows alone, so the rest of
//! the list, and the place the user is reading, stay put.
use super::{Layout, Review};
use crate::review::diff::{Body, FileDiff, RowId, SplitRow};
use gpui::{ListOffset, px};

/// One row of the list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Item {
    Header(usize),
    /// A line, unified.
    Line {
        file: usize,
        line: usize,
    },
    /// A side-by-side row, by its place in the file's pairing.
    Pair {
        file: usize,
        row: usize,
    },
    /// What stands for a file's lines, or says they were cut short.
    Placeholder(usize),
}

impl Item {
    pub(super) fn file(self) -> usize {
        match self {
            Self::Header(file)
            | Self::Placeholder(file)
            | Self::Line { file, .. }
            | Self::Pair { file, .. } => file,
        }
    }
}

/// How many rows `file` takes in `layout`.
fn count(file: &FileDiff, layout: Layout) -> usize {
    if file.folded {
        return 1;
    }
    let body = match &file.body {
        Body::Loaded(lines) if !lines.is_empty() => {
            let rows = match layout {
                Layout::Unified => lines.len(),
                Layout::Split => lines.split().len(),
            };
            rows + usize::from(lines.truncated)
        }
        _ => 1,
    };
    1 + body
}

impl Review {
    /// Works out where each file's rows start, for a new list or layout.
    pub(super) fn rebuild_starts(&mut self) {
        let layout = self.layout;
        let mut starts = Vec::new();
        let mut at = 0;
        if let Some(loaded) = self.loaded() {
            starts.reserve(loaded.diff.files.len() + 1);
            for file in &loaded.diff.files {
                starts.push(at);
                at += count(file, layout);
            }
        }
        starts.push(at);
        self.starts = starts;
    }

    /// What the list shows at `position`.
    pub(super) fn item(&self, position: usize) -> Option<Item> {
        if position >= self.row_count() {
            return None;
        }
        let file = self
            .starts
            .partition_point(|&start| start <= position)
            .checked_sub(1)?;
        let offset = position - self.starts.get(file)?;
        if offset == 0 {
            return Some(Item::Header(file));
        }
        let index = offset - 1;
        let entry = self.loaded()?.diff.files.get(file)?;
        let Some(lines) = entry.lines().filter(|_| !entry.folded) else {
            return Some(Item::Placeholder(file));
        };
        Some(match self.layout {
            Layout::Unified if index < lines.len() => Item::Line { file, line: index },
            Layout::Split if index < lines.split().len() => Item::Pair { file, row: index },
            _ => Item::Placeholder(file),
        })
    }

    /// Where `row` is in the list as drawn; a line of a folded file is at
    /// its header.
    pub(super) fn position_of(&self, row: RowId) -> Option<usize> {
        let start = *self.starts.get(row.file())?;
        let RowId::Line { file, line } = row else {
            return Some(start);
        };
        let entry = self.loaded()?.diff.files.get(file)?;
        let Some(lines) = entry.lines().filter(|_| !entry.folded) else {
            return Some(start);
        };
        let index = match self.layout {
            Layout::Unified => line,
            Layout::Split => lines.split().iter().position(|pair| match *pair {
                SplitRow::Across(across) => across == line,
                SplitRow::Sides { left, right } => left == Some(line) || right == Some(line),
            })?,
        };
        Some(start + 1 + index)
    }

    /// The row an item shows: a side-by-side pair by its left side.
    pub(super) fn row_at(&self, item: Item) -> Option<RowId> {
        Some(match item {
            Item::Header(file) | Item::Placeholder(file) => RowId::Header(file),
            Item::Line { file, line } => RowId::Line { file, line },
            Item::Pair { file, row } => {
                let lines = self.loaded()?.diff.files.get(file)?.lines()?;
                let line = match *lines.split().get(row)? {
                    SplitRow::Across(line) => line,
                    SplitRow::Sides { left, right } => left.or(right)?,
                };
                RowId::Line { file, line }
            }
        })
    }

    pub(super) fn top_item(&self) -> Option<Item> {
        self.item(self.scroll.logical_scroll_top().item_ix)
    }

    /// The row at the top of the diff.
    pub(super) fn top_row(&self) -> Option<RowId> {
        self.top_item().and_then(|item| self.row_at(item))
    }

    /// The file whose rows are at the top of the diff.
    pub(super) fn top_file(&self) -> Option<usize> {
        self.top_item().map(Item::file)
    }

    /// Brings `row` to the top of the diff.
    pub(super) fn scroll_to_row(&mut self, row: RowId) {
        if let Some(position) = self.position_of(row) {
            self.scroll.scroll_to(ListOffset {
                item_ix: position,
                offset_in_item: px(0.),
            });
        }
    }

    /// Lists `file`'s rows again after its lines or folding changed.
    pub(super) fn refresh_file(&mut self, file: usize) {
        let (Some(&start), Some(&end)) = (self.starts.get(file), self.starts.get(file + 1)) else {
            return;
        };
        let layout = self.layout;
        let Some(rows) = self
            .loaded()
            .and_then(|loaded| loaded.diff.files.get(file))
            .map(|entry| count(entry, layout))
        else {
            return;
        };
        self.scroll.splice(start..end, rows);
        for later in &mut self.starts[file + 1..] {
            *later = *later + rows - (end - start);
        }
        // The new rows need a one-line height until they are measured.
        self.hinted.set(None);
    }

    /// Shows the diff in `layout`, the same row at the top.
    pub(super) fn set_layout(&mut self, layout: Layout) {
        if self.layout == layout {
            return;
        }
        let top = self.top_row();
        self.layout = layout;
        self.selection = None;
        self.rebuild_starts();
        let top = top.and_then(|row| self.position_of(row)).unwrap_or(0);
        self.reset_scroll(top);
    }

    /// Folds or opens `file`; the choice holds over reloads.
    pub(super) fn set_folded(&mut self, file: usize, folded: bool) {
        let Some(entry) = self
            .loaded_mut()
            .and_then(|loaded| loaded.diff.files.get_mut(file))
        else {
            return;
        };
        if entry.folded == folded {
            return;
        }
        entry.folded = folded;
        let path = entry.path.clone();
        if folded
            && self
                .selection
                .is_some_and(|selection| selection.file == file)
        {
            self.selection = None;
        }
        self.folds.insert(path, folded);
        if folded
            && self
                .draft
                .is_some_and(|row| row.file() == file && row != RowId::Header(file))
        {
            self.draft = None;
        }
        self.refresh_file(file);
    }

    /// Takes `file`'s lines, or what stands for them.
    pub(super) fn set_body(&mut self, file: usize, body: Body) {
        let Some(entry) = self
            .loaded_mut()
            .and_then(|loaded| loaded.diff.files.get_mut(file))
        else {
            return;
        };
        entry.set_body(body);
        self.colours.forget(file);
        // Its lines are new: offsets into the old ones mean nothing.
        if self
            .selection
            .is_some_and(|selection| selection.file == file)
        {
            self.selection = None;
        }
        self.refresh_file(file);
    }
}
