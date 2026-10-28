//! A file's header in the diff, which folds it, copies its path, marks it
//! viewed and takes a note on the whole file, and the line that stands for
//! its lines while they are unread, binary, or too large to read unasked.
use super::{Review, rows::mark_slot};
use crate::{
    HerdrWindow,
    browser::TabId,
    review::diff::{Body, FileDiff, RowId, Status},
};
use gpui::{prelude::*, *};

/// Counts as a header shows them: `+3 −1`, or nothing unknown.
fn counts(file: &FileDiff) -> Option<(String, String)> {
    Some((
        format!("+{}", file.added?),
        format!("\u{2212}{}", file.removed?),
    ))
}

impl HerdrWindow {
    pub(super) fn review_file_header(
        &self,
        id: TabId,
        review: &Review,
        file: usize,
        line_height: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = &self.theme;
        let Some(entry) = review
            .loaded()
            .and_then(|loaded| loaded.diff.files.get(file))
        else {
            return div().into_any_element();
        };
        let row = RowId::Header(file);
        let viewed = review.is_viewed(file);
        let name = match &entry.old_path {
            Some(old) if entry.status == Status::Renamed => {
                format!("{old} \u{2192} {}", entry.path)
            }
            _ => entry.path.clone(),
        };
        let fold = div()
            .id(("review-fold", file))
            .debug_selector(move || format!("review-fold-{file}"))
            .flex_none()
            .size(px(line_height))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .rounded(px(crate::config::corners::CONTROL))
            .hover(|button| button.bg(rgb(theme.surface)))
            .child(
                svg()
                    .path(if entry.folded {
                        "icons/chevron-right.svg"
                    } else {
                        "icons/chevron-down.svg"
                    })
                    .size(px(12.))
                    .text_color(rgb(theme.muted)),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                this.toggle_review_fold(id, file, cx);
            }));
        let check = div()
            .id(("review-viewed", file))
            .debug_selector(move || format!("review-viewed-{file}"))
            .flex_none()
            .flex()
            .items_center()
            .gap_1()
            .px_1()
            .cursor_pointer()
            .rounded(px(crate::config::corners::CONTROL))
            .hover(|button| button.bg(rgb(theme.surface)))
            .text_color(rgb(theme.muted))
            .font_weight(FontWeight::NORMAL)
            .child(crate::toggles::checkbox(theme, 12., viewed))
            .child("Viewed")
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                this.toggle_review_viewed(id, file, cx);
            }));
        let counts = counts(entry).map(|(added, removed)| {
            div()
                .flex_none()
                .flex()
                .gap_1()
                .font_weight(FontWeight::NORMAL)
                .child(
                    div()
                        .text_color(rgb(theme.ink(theme.palette[2])))
                        .child(added),
                )
                .child(
                    div()
                        .text_color(rgb(theme.ink(theme.palette[1])))
                        .child(removed),
                )
        });
        div()
            .id(("review-header", file))
            .debug_selector(move || format!("review-header-{file}"))
            .w_full()
            .min_h(px(line_height))
            .line_height(px(line_height))
            .flex()
            .items_start()
            .gap_1()
            .pr_2()
            .bg(rgb(theme.active))
            .when(review.draft == Some(row), |header| {
                header.bg(rgb(theme.surface))
            })
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(theme.foreground))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                this.begin_review_note(id, row, window, cx);
            }))
            .child(mark_slot(theme, review.marks.get(&row).copied()).h(px(line_height)))
            .child(fold)
            .child(div().flex_1().min_w_0().child(name))
            .when(!entry.status.label().is_empty(), |header| {
                header.child(
                    div()
                        .flex_none()
                        .font_weight(FontWeight::NORMAL)
                        .text_color(rgb(theme.muted))
                        .child(entry.status.label()),
                )
            })
            .children(counts)
            .child(
                super::rows::copy_button(theme, line_height)
                    .id(("review-copy-path", file))
                    .debug_selector(move || format!("review-copy-path-{file}"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.copy_review_path(id, file, cx);
                    })),
            )
            .child(check)
            .into_any_element()
    }

    /// What stands for `file`'s lines, or says they were cut short.
    pub(super) fn review_placeholder(
        &self,
        id: TabId,
        review: &Review,
        file: usize,
        line_height: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = &self.theme;
        let Some(entry) = review
            .loaded()
            .and_then(|loaded| loaded.diff.files.get(file))
        else {
            return div().into_any_element();
        };
        let reading = review.reading.contains(&file);
        let (text, action) = match &entry.body {
            _ if reading => ("Reading\u{2026}".to_owned(), None),
            Body::Pending => ("Reading\u{2026}".to_owned(), None),
            Body::Binary => ("Binary file not shown".to_owned(), None),
            Body::Large => (
                match counts(entry) {
                    Some((added, removed)) => {
                        format!("Large change not shown: {added} {removed} lines")
                    }
                    None => "Large file not shown".to_owned(),
                },
                Some("Load diff"),
            ),
            Body::Failed(why) => (why.clone(), Some("Try again")),
            Body::Loaded(lines) if lines.truncated => {
                (format!("Cut short after {} lines", lines.len()), None)
            }
            Body::Loaded(_) => ("No changes to show".to_owned(), None),
        };
        div()
            .id(("review-placeholder", file))
            .debug_selector(move || format!("review-placeholder-{file}"))
            .w_full()
            .min_h(px(line_height))
            .line_height(px(line_height))
            .flex()
            .items_center()
            .gap_2()
            .pl(px(40.))
            .text_color(rgb(theme.muted))
            .child(text)
            .when_some(action, |row, action| {
                row.child(
                    div()
                        .id(("review-load", file))
                        .debug_selector(move || format!("review-load-{file}"))
                        .px_2()
                        .rounded(px(crate::config::corners::CONTROL))
                        .cursor_pointer()
                        .bg(rgb(theme.active))
                        .text_color(rgb(theme.foreground))
                        .hover(|button| button.bg(rgb(theme.surface)))
                        .child(action)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.load_review_file(id, file, cx);
                        })),
                )
            })
            .into_any_element()
    }

    /// Folds `file` or opens it.
    pub(super) fn toggle_review_fold(&mut self, id: TabId, file: usize, cx: &mut Context<Self>) {
        if let Some(review) = self.reviews.get_mut(&id) {
            let folded = review
                .loaded()
                .and_then(|loaded| loaded.diff.files.get(file))
                .is_some_and(|entry| entry.folded);
            review.set_folded(file, !folded);
        }
        cx.notify();
    }

    /// Marks `file` viewed, which folds it, or not viewed, which opens it.
    pub(super) fn toggle_review_viewed(&mut self, id: TabId, file: usize, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let Some((path, counts)) = review
            .loaded()
            .and_then(|loaded| loaded.diff.files.get(file))
            .map(|entry| (entry.path.clone(), (entry.added, entry.removed)))
        else {
            return;
        };
        let viewed = review.viewed.get(&path) == Some(&counts);
        if viewed {
            review.viewed.remove(&path);
        } else {
            review.viewed.insert(path, counts);
        }
        review.set_folded(file, !viewed);
        review.refresh_shown();
        cx.notify();
    }
}
