//! Keys in the diff, while it holds the keyboard: `j`/`k` and the arrows
//! scroll a line, Space and Page Up/Down a page, `]`/`[` move between hunks
//! and `.`/`,` between files, `/` finds, `n`/`N` step through the matches,
//! `x` folds the file at the top and `v` marks it viewed. Cmd-C copies the
//! selected code, Cmd-A selects the file's, and Escape clears it. Fields in
//! the review keep their own keys.
use super::Review;
use crate::{HerdrWindow, browser::TabId, review::diff::RowId};
use gpui::{prelude::*, *};

/// A move through the diff.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    Lines(f32),
    Pages(f32),
    Hunk { back: bool },
    File { back: bool },
}

impl Review {
    /// The hunk header after the top row, or before it with `back`; past
    /// the top file's hunks, the next file's first or the last file's last,
    /// or its header when it shows none.
    fn next_hunk(&self, back: bool) -> Option<RowId> {
        let files = &self.loaded()?.diff.files;
        let hunks = |file: usize| -> &[usize] {
            files
                .get(file)
                .filter(|entry| !entry.folded)
                .and_then(|entry| entry.lines())
                .map_or(&[], |lines| lines.hunks())
        };
        let (here, line) = match self.top_row()? {
            RowId::Header(file) => (file, None),
            RowId::Line { file, line } => (file, Some(line)),
        };
        let hunk = |file: usize, line: usize| RowId::Line { file, line };
        if back {
            if let Some(line) = line {
                let before = hunks(here).iter().rev().find(|&&header| header < line);
                return Some(before.map_or(RowId::Header(here), |&header| hunk(here, header)));
            }
            let file = here.checked_sub(1)?;
            return Some(
                hunks(file)
                    .last()
                    .map_or(RowId::Header(file), |&header| hunk(file, header)),
            );
        }
        if let Some(&header) = hunks(here)
            .iter()
            .find(|&&header| line.is_none_or(|line| header > line))
        {
            return Some(hunk(here, header));
        }
        let file = here + 1;
        (file < files.len()).then(|| {
            hunks(file)
                .first()
                .map_or(RowId::Header(file), |&header| hunk(file, header))
        })
    }

    fn next_file(&self, back: bool) -> Option<RowId> {
        let count = self.loaded()?.diff.files.len();
        let here = self.top_file()?;
        let at_header = self.top_row() == Some(RowId::Header(here));
        let file = match back {
            false => here + 1,
            true if at_header => here.checked_sub(1)?,
            true => here,
        };
        (file < count).then_some(RowId::Header(file))
    }

    fn step(&mut self, step: Step, line_height: f32) {
        match step {
            Step::Lines(lines) => self.scroll.scroll_by(px(lines * line_height)),
            Step::Pages(pages) => {
                let height = f32::from(self.scroll.viewport_bounds().size.height);
                self.scroll
                    .scroll_by(px(pages * (height - 2. * line_height).max(line_height)));
            }
            Step::Hunk { back } => {
                if let Some(row) = self.next_hunk(back) {
                    self.scroll_to_row(row);
                }
            }
            Step::File { back } => {
                if let Some(row) = self.next_file(back) {
                    self.scroll_to_row(row);
                }
            }
        }
    }
}

impl HerdrWindow {
    /// Handles a key in the diff; whether it was the review's.
    pub(super) fn review_key(
        &mut self,
        id: TabId,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        // Copy and Select All, with Cmd or, as off macOS, Ctrl: the diff
        // has no program to send Ctrl-C to.
        let edit = (modifiers.platform != modifiers.control)
            && !modifiers.alt
            && !modifiers.shift
            && !modifiers.function;
        match keystroke.key.as_str() {
            "c" if edit => return self.copy_review_selection(id, cx),
            "a" if edit => {
                self.select_review_file(id, cx);
                return true;
            }
            "escape" if !modifiers.modified() && self.clear_review_selection(id, cx) => {
                return true;
            }
            _ => {}
        }
        if modifiers.control || modifiers.alt || modifiers.platform || modifiers.function {
            return false;
        }
        let line_height = self.review_line_height();
        let shift = modifiers.shift;
        let step = match (keystroke.key.as_str(), shift) {
            ("j" | "down", false) => Some(Step::Lines(1.)),
            ("k" | "up", false) => Some(Step::Lines(-1.)),
            ("space", false) | ("pagedown", _) => Some(Step::Pages(1.)),
            ("space", true) | ("pageup", _) => Some(Step::Pages(-1.)),
            ("]", false) => Some(Step::Hunk { back: false }),
            ("[", false) => Some(Step::Hunk { back: true }),
            (".", false) => Some(Step::File { back: false }),
            (",", false) => Some(Step::File { back: true }),
            _ => None,
        };
        if let Some(step) = step {
            if let Some(review) = self.reviews.get_mut(&id) {
                review.step(step, line_height);
            }
            cx.notify();
            return true;
        }
        let top = self.reviews.get(&id).and_then(Review::top_file);
        match (keystroke.key.as_str(), shift) {
            ("/", false) => self.open_review_search(id, window, cx),
            ("n", false) => self.step_review_search(id, false, cx),
            ("n", true) => self.step_review_search(id, true, cx),
            ("x", false) => {
                if let Some(file) = top {
                    self.toggle_review_fold(id, file, cx);
                    if let Some(review) = self.reviews.get_mut(&id) {
                        review.scroll_to_row(RowId::Header(file));
                    }
                }
            }
            ("v", false) => {
                if let Some(file) = top {
                    self.toggle_review_viewed(id, file, cx);
                    if let Some(review) = self.reviews.get_mut(&id) {
                        review.scroll_to_row(RowId::Header(file));
                    }
                }
            }
            ("home", false) => {
                if let Some(review) = self.reviews.get_mut(&id) {
                    review.scroll.scroll_to(ListOffset {
                        item_ix: 0,
                        offset_in_item: px(0.),
                    });
                }
            }
            ("end", false) => {
                if let Some(review) = self.reviews.get_mut(&id) {
                    review.scroll.scroll_to_end();
                }
            }
            _ => return false,
        }
        cx.notify();
        true
    }
}
