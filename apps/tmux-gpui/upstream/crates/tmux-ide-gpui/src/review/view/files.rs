//! The review's changed files, left of the diff as a pull request's file
//! tree is: under folders that fold, each with how it changed, its line
//! counts, the notes queued on it and whether it was viewed. A filter keeps
//! the files whose path holds it, and viewed files can be hidden. Clicking a
//! file, or Enter on the one picked with the arrows, brings its header to the
//! top of the diff; the file at the top of the diff is marked, and kept in
//! view as the diff scrolls.
use super::{Review, tree::Node};
use crate::browser::TabId;
use crate::{
    HerdrWindow,
    config::Theme,
    panel_resize::PanelDrag,
    review::diff::{Anchor, Body, FileDiff, RowId, Status},
};
use gpui::{prelude::*, *};
use std::collections::HashMap;

/// The letter a file's change shows as, and its colour.
fn status(theme: &Theme, status: Status) -> (&'static str, u32) {
    let colour = match status {
        Status::Added | Status::Untracked => theme.ink(theme.palette[2]),
        Status::Deleted => theme.ink(theme.palette[1]),
        Status::Renamed => theme.ink(theme.palette[4]),
        Status::Modified => theme.ink(theme.palette[3]),
    };
    (status.letter(), colour)
}

/// A file's counts as the list shows them, zeros left out.
fn counts(theme: &Theme, entry: &FileDiff) -> Div {
    let count = |value: Option<u32>, sign: &str, colour: u32| {
        value.filter(|value| *value > 0).map(|value| {
            div()
                .text_color(rgb(colour))
                .child(format!("{sign}{value}"))
        })
    };
    div()
        .flex_none()
        .flex()
        .gap_1()
        .text_size(px(11.))
        .children(count(entry.added, "+", theme.ink(theme.palette[2])))
        .children(count(
            entry.removed,
            "\u{2212}",
            theme.ink(theme.palette[1]),
        ))
}

impl Review {
    /// Works out which lines the file list shows, after the filter, the
    /// folders or the viewed files changed.
    pub(super) fn refresh_shown(&mut self) {
        let query = self.filter_text.to_lowercase();
        let filtered = !query.is_empty();
        let Some(loaded) = self.loaded() else {
            self.shown.clear();
            return;
        };
        let files = &loaded.diff.files;
        let shown = self.tree.shown(&self.closed, filtered, |file| {
            files.get(file).is_some_and(|entry| {
                (!filtered || entry.path.to_lowercase().contains(&query))
                    && !(self.hide_viewed && self.is_viewed(file))
            })
        });
        self.shown = shown;
        self.picked = self.picked.filter(|picked| *picked < self.shown.len());
    }

    /// The file on line `line` of the list, if a file is there.
    fn file_at(&self, line: usize) -> Option<usize> {
        match self.tree.nodes.get(*self.shown.get(line)?)? {
            Node::File { file, .. } => Some(*file),
            Node::Folder { .. } => None,
        }
    }
}

impl HerdrWindow {
    /// Brings `file`'s header to the top of the diff.
    pub(super) fn jump_to_review_file(&mut self, id: TabId, file: usize, cx: &mut Context<Self>) {
        if let Some(review) = self.reviews.get_mut(&id) {
            review.scroll_to_row(RowId::Header(file));
            // The list follows the diff: the file it jumped to is current.
            review.revealed.set(Some(file));
        }
        cx.notify();
    }

    /// Opens or closes the folder at `node` of the tree.
    fn toggle_review_folder(&mut self, id: TabId, node: usize, cx: &mut Context<Self>) {
        if let Some(review) = self.reviews.get_mut(&id)
            && let Some(Node::Folder { path, .. }) = review.tree.nodes.get(node)
        {
            let path = path.clone();
            if !review.closed.remove(&path) {
                review.closed.insert(path);
            }
            review.refresh_shown();
        }
        cx.notify();
    }

    /// Follows the filter's text as it is typed.
    pub(super) fn review_filter_changed(&mut self, id: TabId, cx: &mut Context<Self>) {
        if let Some(review) = self.reviews.get_mut(&id) {
            review.filter_text = review.filter.read(cx).text().to_owned();
            review.refresh_shown();
            review.picked = (!review.shown.is_empty()).then_some(0);
        }
        cx.notify();
    }

    /// Arrows pick a line of the list, Enter shows it, Left and Right close
    /// and open a folder; whether the key was the list's. While the filter
    /// is typed in, Left and Right stay the filter's.
    fn review_files_key(
        &mut self,
        id: TabId,
        key: &str,
        filtering: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(review) = self.reviews.get_mut(&id) else {
            return false;
        };
        let count = review.shown.len();
        if count == 0 {
            return false;
        }
        let picked = review.picked;
        let folder = picked
            .and_then(|line| review.shown.get(line).copied())
            .and_then(|node| match review.tree.nodes.get(node)? {
                Node::Folder { path, .. } => Some((node, review.closed.contains(path))),
                Node::File { .. } => None,
            });
        match key {
            "down" => review.picked = Some(picked.map_or(0, |line| (line + 1).min(count - 1))),
            "up" => review.picked = Some(picked.map_or(0, |line| line.saturating_sub(1))),
            "enter" => {
                if let Some(file) = picked.and_then(|line| review.file_at(line)) {
                    self.jump_to_review_file(id, file, cx);
                } else if let Some((node, _)) = folder {
                    self.toggle_review_folder(id, node, cx);
                }
                return true;
            }
            "left" | "right" if !filtering => {
                if let Some((node, closed)) = folder
                    && closed == (key == "right")
                {
                    self.toggle_review_folder(id, node, cx);
                }
                return true;
            }
            _ => return false,
        }
        if let Some(line) = review.picked {
            review
                .files_scroll
                .scroll_to_item(line, ScrollStrategy::Nearest);
        }
        cx.notify();
        true
    }

    /// Picks line `line` of the list, which then takes the arrows.
    fn pick_review_file(
        &mut self,
        id: TabId,
        line: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(review) = self.reviews.get_mut(&id) {
            review.picked = Some(line);
            let focus = review.files_focus.clone();
            window.focus(&focus, cx);
        }
    }

    /// The file list, resizable by its right edge.
    pub(super) fn render_review_files(
        &self,
        id: TabId,
        review: &Review,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let theme = &self.theme;
        let line_height = self.config.ui.line_height() + 8.;
        let count = review.shown.len();
        let files = review.loaded().map_or(0, |loaded| loaded.diff.files.len());
        // Keeps the file at the top of the diff in view in the list.
        let current = review.top_file();
        if current.is_some() && review.revealed.get() != current {
            review.revealed.set(current);
            let line = review.shown.iter().position(|&node| {
                matches!(review.tree.nodes.get(node), Some(Node::File { file, .. }) if Some(*file) == current)
            });
            if let Some(line) = line {
                review
                    .files_scroll
                    .scroll_to_item(line, ScrollStrategy::Nearest);
            }
        }
        let hide = div()
            .id("review-hide-viewed")
            .debug_selector(|| "review-hide-viewed".into())
            .flex_none()
            .px_1()
            .rounded(px(crate::config::corners::CONTROL))
            .cursor_pointer()
            .text_color(rgb(if review.hide_viewed {
                theme.foreground
            } else {
                theme.muted
            }))
            .when(review.hide_viewed, |button| button.bg(rgb(theme.active)))
            .hover(|button| button.bg(rgb(theme.active)))
            .child("Hide viewed")
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(review) = this.reviews.get_mut(&id) {
                    review.hide_viewed = !review.hide_viewed;
                    review.refresh_shown();
                }
                cx.notify();
            }));
        let panel = div()
            .id("review-files")
            .debug_selector(|| "review-files".into())
            .track_focus(&review.files_focus)
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(rgb(theme.active))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                let Some(filter) = this.reviews.get(&id).map(|review| review.filter.read(cx))
                else {
                    return;
                };
                let (composing, filtering) =
                    (filter.is_composing(), filter.focus.is_focused(window));
                let key = event.keystroke.key.as_str();
                if !composing && this.review_files_key(id, key, filtering, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .py_1()
                    .text_color(rgb(theme.muted))
                    .child(div().flex_1().min_w_0().truncate().child(if files == 1 {
                        "1 file changed".to_owned()
                    } else {
                        format!("{files} files changed")
                    }))
                    .child(hide),
            )
            .child(
                div()
                    .id("review-filter")
                    .debug_selector(|| "review-filter".into())
                    .mx_2()
                    .mb_1()
                    .px_1()
                    .flex()
                    .items_center()
                    .gap_1()
                    .rounded(px(crate::config::corners::CONTROL))
                    .border_1()
                    .border_color(rgb(theme.active))
                    .child(
                        svg()
                            .path("icons/search.svg")
                            .flex_none()
                            .size(px(12.))
                            .text_color(rgb(theme.muted)),
                    )
                    .child(div().flex_1().min_w_0().child(review.filter.clone())),
            )
            .child(
                uniform_list(
                    "review-file-list",
                    count,
                    cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                        this.review_file_rows(id, range, line_height, cx)
                    }),
                )
                .track_scroll(&review.files_scroll)
                .flex_1()
                .min_h_0(),
            );
        self.resizable_panel(
            panel,
            "review-files-resize",
            PanelDrag::ReviewFiles,
            Some(super::PANEL_SHARE),
            cx,
        )
    }

    fn review_file_rows(
        &mut self,
        id: TabId,
        range: std::ops::Range<usize>,
        line_height: f32,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let theme = &self.theme;
        let Some(review) = self.reviews.get(&id) else {
            return Vec::new();
        };
        let Some(loaded) = review.loaded() else {
            return Vec::new();
        };
        let current = review.top_file();
        let mut notes: HashMap<&str, usize> = HashMap::new();
        for note in &review.notes {
            let (Anchor::File { path } | Anchor::Line { path, .. }) = &note.anchor;
            *notes.entry(path.as_str()).or_default() += 1;
        }
        range
            .filter_map(|line| {
                let node_index = *review.shown.get(line)?;
                let node = review.tree.nodes.get(node_index)?;
                // Each line spans the list, so the current file's band does.
                let row = div()
                    .w_full()
                    .h(px(line_height))
                    .pr_2()
                    .pl(px(8. + 12. * node.depth() as f32))
                    .flex()
                    .items_center()
                    .gap_1()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .cursor_pointer()
                    .rounded(px(crate::config::corners::CONTROL))
                    .when(review.picked == Some(line), |row| {
                        row.border_1().border_color(rgb(theme.muted))
                    })
                    .hover(|row| row.bg(rgb(theme.active)));
                Some(match node {
                    Node::Folder { path, label, .. } => {
                        let closed = review.closed.contains(path);
                        row.id(("review-folder", node_index))
                            .debug_selector(move || format!("review-folder-{node_index}"))
                            .text_color(rgb(theme.muted))
                            .child(
                                svg()
                                    .path(if closed {
                                        "icons/chevron-right.svg"
                                    } else {
                                        "icons/chevron-down.svg"
                                    })
                                    .flex_none()
                                    .size(px(10.))
                                    .text_color(rgb(theme.muted)),
                            )
                            .child(div().min_w_0().truncate().child(label.clone()))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.pick_review_file(id, line, window, cx);
                                this.toggle_review_folder(id, node_index, cx);
                            }))
                            .into_any_element()
                    }
                    Node::File { file, .. } => {
                        let file = *file;
                        let entry = loaded.diff.files.get(file)?;
                        let name = entry
                            .path
                            .rsplit('/')
                            .next()
                            .unwrap_or(&entry.path)
                            .to_owned();
                        let (letter, colour) = status(theme, entry.status);
                        let noted = notes.get(entry.path.as_str()).copied().unwrap_or(0);
                        let viewed = review.is_viewed(file);
                        let dim = viewed || entry.body == Body::Binary;
                        row.id(("review-file", file))
                            .debug_selector(move || format!("review-file-{file}"))
                            .when(current == Some(file), |row| row.bg(rgb(theme.active)))
                            .text_color(rgb(if dim { theme.muted } else { theme.foreground }))
                            .child(
                                div()
                                    .flex_none()
                                    .w(px(12.))
                                    .text_color(rgb(colour))
                                    .child(letter),
                            )
                            .child(div().flex_1().min_w_0().truncate().child(name))
                            .when(noted > 0, |row| {
                                row.child(
                                    div()
                                        .flex_none()
                                        .px_1()
                                        .rounded_full()
                                        .bg(rgb(theme.palette[3]))
                                        .text_color(rgb(theme.text_on(theme.palette[3])))
                                        .text_size(px(10.))
                                        .child(noted.to_string()),
                                )
                            })
                            .when(viewed, |row| {
                                row.child(
                                    svg()
                                        .path("icons/check.svg")
                                        .flex_none()
                                        .size(px(10.))
                                        .text_color(rgb(theme.muted)),
                                )
                            })
                            .child(counts(theme, entry))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.pick_review_file(id, line, window, cx);
                                this.jump_to_review_file(id, file, cx);
                            }))
                            .into_any_element()
                    }
                })
            })
            .collect()
    }
}
