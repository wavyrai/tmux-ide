//! Selecting the diff's code to copy, as in an editor: press and drag over
//! the code, double-click a word, triple-click a line, Shift-click to
//! extend, Cmd-A for the file at the top. A selection stays within one file
//! and, side by side, within the side it started on, and it holds code
//! alone: never line numbers, `+`/`-` signs, or hunk headers. The gutter
//! beside the code takes notes instead.
use super::{Review, rows::Numbers};
use crate::{
    HerdrWindow,
    browser::TabId,
    review::diff::{Kind, Lines},
    window::Flash,
};
use gpui::{ClipboardItem, Context, Window};
use std::ops::Range;

/// A place in one line's code: the line's index in its file, and a byte
/// offset into its text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Caret {
    pub line: usize,
    pub offset: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Selection {
    pub file: usize,
    /// Which column the code is in: the unified one, or a side.
    pub side: Numbers,
    pub anchor: Caret,
    pub head: Caret,
}

/// Whether a line of `kind` shows its code in `side`.
fn shows_on(kind: Kind, side: Numbers) -> bool {
    match side {
        Numbers::Both => matches!(kind, Kind::Added | Kind::Removed | Kind::Context),
        Numbers::Old => matches!(kind, Kind::Removed | Kind::Context),
        Numbers::New => matches!(kind, Kind::Added | Kind::Context),
    }
}

/// The nearest character boundary at or before `offset` in `text`.
fn floor_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The word around `offset` in `text`, or the one character there when it
/// is not part of a word.
pub(super) fn word_at(text: &str, offset: usize) -> Range<usize> {
    let offset = floor_boundary(text, offset);
    let Some(here) = text[offset..].chars().next() else {
        return offset..offset;
    };
    if !is_word(here) {
        return offset..offset + here.len_utf8();
    }
    let start = text[..offset]
        .char_indices()
        .rev()
        .take_while(|&(_, c)| is_word(c))
        .last()
        .map_or(offset, |(at, _)| at);
    let end = text[offset..]
        .char_indices()
        .find(|&(_, c)| !is_word(c))
        .map_or(text.len(), |(at, _)| offset + at);
    start..end
}

impl Selection {
    /// The selection's start and end, in reading order.
    fn ordered(&self) -> (Caret, Caret) {
        if self.anchor <= self.head {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.anchor == self.head
    }

    /// The part of line `line`, of text length `len`, that is selected when
    /// drawn in `side` of `file`, even if empty.
    fn span(&self, file: usize, side: Numbers, line: usize, len: usize) -> Option<Range<usize>> {
        if file != self.file || side != self.side {
            return None;
        }
        let (start, end) = self.ordered();
        if line < start.line || line > end.line {
            return None;
        }
        let from = if line == start.line { start.offset } else { 0 };
        let to = if line == end.line { end.offset } else { len };
        Some(from.min(len)..to.min(len))
    }

    /// The part of line `line` to tint, if any of it is selected.
    pub(super) fn highlight(
        &self,
        file: usize,
        side: Numbers,
        line: usize,
        text: &str,
    ) -> Option<Range<usize>> {
        let span = self.span(file, side, line, text.len())?;
        let span = floor_boundary(text, span.start)..floor_boundary(text, span.end);
        (span.start < span.end).then_some(span)
    }

    /// The selected code, its lines joined by newlines: only lines that
    /// show in the selection's column, and only their code.
    pub(super) fn text(&self, lines: &Lines) -> String {
        let (start, end) = self.ordered();
        let mut copied: Vec<&str> = Vec::new();
        for index in start.line..=end.line.min(lines.len().saturating_sub(1)) {
            let Some(line) = lines
                .get(index)
                .filter(|line| shows_on(line.kind, self.side))
            else {
                continue;
            };
            let text = lines.text_of(line);
            if let Some(span) = self.span(self.file, self.side, index, text.len()) {
                copied
                    .push(&text[floor_boundary(text, span.start)..floor_boundary(text, span.end)]);
            }
        }
        copied.join("\n")
    }

    /// Every line of `lines` in `side` of `file`.
    pub(super) fn all(file: usize, side: Numbers, lines: &Lines) -> Option<Self> {
        let shown = |(index, line): (usize, &crate::review::diff::Line)| {
            shows_on(line.kind, side).then(|| (index, lines.text_of(line).len()))
        };
        let (first, _) = lines.iter().enumerate().find_map(shown)?;
        let (last, len) = lines.iter().enumerate().filter_map(shown).last()?;
        Some(Self {
            file,
            side,
            anchor: Caret {
                line: first,
                offset: 0,
            },
            head: Caret {
                line: last,
                offset: len,
            },
        })
    }
}

/// Where a press lands in the code of line `line` of `file`, drawn in
/// `side`: its byte `offset`, how many clicks it is, and whether Shift is
/// held to extend the selection.
#[derive(Clone, Copy, Debug)]
pub(super) struct Press {
    pub file: usize,
    pub side: Numbers,
    pub line: usize,
    pub offset: usize,
    pub clicks: usize,
    pub extend: bool,
}

impl Review {
    /// The lines of `file`, if read.
    fn file_lines(&self, file: usize) -> Option<&std::sync::Arc<Lines>> {
        self.loaded()?.diff.files.get(file)?.lines()
    }

    /// Starts a selection at a press, or extends the one there with Shift.
    pub(super) fn press_code(&mut self, press: Press) {
        self.selecting = true;
        let caret = Caret {
            line: press.line,
            offset: press.offset,
        };
        if press.extend
            && let Some(selection) = self
                .selection
                .as_mut()
                .filter(|selection| selection.file == press.file && selection.side == press.side)
        {
            selection.head = caret;
            return;
        }
        let text = self
            .file_lines(press.file)
            .map(|lines| lines.text(press.line))
            .unwrap_or("");
        let (anchor, head) = match press.clicks {
            0 | 1 => (press.offset, press.offset),
            2 => {
                let word = word_at(text, press.offset);
                (word.start, word.end)
            }
            _ => (0, text.len()),
        };
        self.selection = Some(Selection {
            file: press.file,
            side: press.side,
            anchor: Caret {
                line: press.line,
                offset: anchor,
            },
            head: Caret {
                line: press.line,
                offset: head,
            },
        });
    }

    /// Moves the selection's end to where a drag that started on the code
    /// reached; whether it moved. A drag over another file or side leaves it
    /// where it was.
    pub(super) fn drag_code(
        &mut self,
        file: usize,
        side: Numbers,
        line: usize,
        offset: usize,
    ) -> bool {
        let Some(selection) = self.selection.as_mut().filter(|_| self.selecting) else {
            return false;
        };
        let head = Caret { line, offset };
        if selection.file != file || selection.side != side || selection.head == head {
            return false;
        }
        selection.head = head;
        true
    }

    /// The column a selection of the whole file takes in this layout: the
    /// new side, side by side, as that is the code the change leaves.
    fn whole_file_side(&self) -> Numbers {
        match self.layout {
            super::Layout::Unified => Numbers::Both,
            super::Layout::Split => Numbers::New,
        }
    }

    /// Selects the code of the file at the top, in the column last selected
    /// in when that was this file, as a click in the old column means to read
    /// that side; whether there was code to select. A selection left in a
    /// file scrolled away does not choose the file, and a folded file shows
    /// no code to select. A side without code, as the new side of a deleted
    /// file, gives way to the other.
    pub(super) fn select_file(&mut self) -> bool {
        let Some(file) = self.top_file() else {
            return false;
        };
        if self
            .loaded()
            .and_then(|loaded| loaded.diff.files.get(file))
            .is_none_or(|entry| entry.folded)
        {
            return false;
        }
        let side = self
            .selection
            .filter(|selection| selection.file == file)
            .map_or_else(|| self.whole_file_side(), |selection| selection.side);
        let other = match side {
            Numbers::Both => None,
            Numbers::Old => Some(Numbers::New),
            Numbers::New => Some(Numbers::Old),
        };
        let all = self.file_lines(file).and_then(|lines| {
            Selection::all(file, side, lines)
                .or_else(|| other.and_then(|other| Selection::all(file, other, lines)))
        });
        if all.is_some() {
            self.selection = all;
        }
        all.is_some()
    }

    /// The selected code, if any is selected. A selection of lines without
    /// code, such as a "No newline at end of file" marker, has none.
    pub(super) fn selected_code(&self) -> Option<String> {
        let selection = self.selection.filter(|selection| !selection.is_empty())?;
        Some(selection.text(self.file_lines(selection.file)?)).filter(|text| !text.is_empty())
    }
}

impl HerdrWindow {
    /// Writes the selected code to the clipboard; whether there was any.
    pub(super) fn copy_review_selection(&mut self, id: TabId, cx: &mut Context<Self>) -> bool {
        let Some(text) = self.reviews.get(&id).and_then(Review::selected_code) else {
            return false;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.show_flash(Flash::success("Copied to clipboard"), cx);
        true
    }

    /// Ends a drag over the code, wherever the button came up.
    pub(super) fn release_review_code(&mut self, id: TabId) {
        if let Some(review) = self.reviews.get_mut(&id) {
            review.selecting = false;
        }
    }

    pub(super) fn select_review_file(&mut self, id: TabId, cx: &mut Context<Self>) {
        if self.reviews.get_mut(&id).is_some_and(Review::select_file) {
            cx.notify();
        }
    }

    /// Clears the selection; whether there was one.
    pub(super) fn clear_review_selection(&mut self, id: TabId, cx: &mut Context<Self>) -> bool {
        let cleared = self
            .reviews
            .get_mut(&id)
            .and_then(|review| review.selection.take())
            .is_some();
        if cleared {
            cx.notify();
        }
        cleared
    }

    /// A press on the code of a line: the review takes the keyboard, so
    /// Cmd-C copies what the press selects.
    pub(super) fn press_review_code(
        &mut self,
        id: TabId,
        press: Press,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        review.press_code(press);
        let focus = review.focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(super) fn drag_review_code(
        &mut self,
        id: TabId,
        file: usize,
        side: Numbers,
        line: usize,
        offset: usize,
        cx: &mut Context<Self>,
    ) {
        if self
            .reviews
            .get_mut(&id)
            .is_some_and(|review| review.drag_code(file, side, line, offset))
        {
            cx.notify();
        }
    }

    /// Writes `text` to the clipboard and says what it was.
    pub(super) fn copy_review_text(
        &mut self,
        text: String,
        what: &'static str,
        cx: &mut Context<Self>,
    ) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.show_flash(Flash::success(what), cx);
    }

    /// Copies the path of `file`.
    pub(super) fn copy_review_path(&mut self, id: TabId, file: usize, cx: &mut Context<Self>) {
        let Some(path) = self
            .reviews
            .get(&id)
            .and_then(|review| review.loaded()?.diff.files.get(file))
            .map(|entry| entry.path.clone())
        else {
            return;
        };
        self.copy_review_text(path, "Path copied", cx);
    }

    /// Copies the hunk whose header is line `header` of `file`, as a patch
    /// reads: its header, then each line behind its sign.
    pub(super) fn copy_review_hunk(
        &mut self,
        id: TabId,
        file: usize,
        header: usize,
        cx: &mut Context<Self>,
    ) {
        let Some(lines) = self
            .reviews
            .get(&id)
            .and_then(|review| review.file_lines(file))
        else {
            return;
        };
        let text = hunk_text(lines, header);
        self.copy_review_text(text, "Hunk copied", cx);
    }
}

/// The hunk whose header is line `header`, as a patch reads.
pub(super) fn hunk_text(lines: &Lines, header: usize) -> String {
    let mut text = String::new();
    for (index, line) in lines.iter().enumerate().skip(header) {
        if index > header && line.kind == Kind::Hunk {
            break;
        }
        let sign = match line.kind {
            Kind::Hunk | Kind::Meta => "",
            Kind::Added => "+",
            Kind::Removed => "-",
            Kind::Context => " ",
        };
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(sign);
        text.push_str(lines.text_of(line));
    }
    text
}

#[cfg(test)]
mod tests;
