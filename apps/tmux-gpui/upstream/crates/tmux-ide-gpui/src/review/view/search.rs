//! Finding text in the diff. The read lines are searched on the background
//! executor whenever the query or the lines change; Enter and Shift-Enter,
//! or `n` and `N` in the diff, step through the matches, opening a folded
//! file to show one. A query with no capitals ignores ASCII case. Files not
//! read yet are not searched until they are.
use super::Review;
use crate::{
    HerdrWindow,
    browser::TabId,
    review::diff::{Lines, RowId},
    search_input::SearchInput,
};
use gpui::{prelude::*, *};
use std::{collections::HashSet, sync::Arc};

/// Matches kept at most.
const MAX_MATCHES: usize = 10_000;

pub(super) struct Search {
    pub open: bool,
    pub input: Entity<SearchInput>,
    query: String,
    matches: Vec<RowId>,
    found: HashSet<RowId>,
    /// The match shown, by its place in `matches`.
    current: Option<usize>,
    /// More matched than are kept.
    capped: bool,
    /// Numbers searches, so only the latest lands.
    request: u64,
}

impl Search {
    pub(super) fn new(input: Entity<SearchInput>) -> Self {
        Self {
            open: false,
            input,
            query: String::new(),
            matches: Vec::new(),
            found: HashSet::new(),
            current: None,
            capped: false,
            request: 0,
        }
    }

    pub(super) fn clear_results(&mut self) {
        self.matches.clear();
        self.found.clear();
        self.current = None;
        self.capped = false;
        self.request += 1;
    }

    /// Whether `row` matched, and whether it is the match shown.
    pub(super) fn found(&self, row: RowId) -> Option<bool> {
        self.found.contains(&row).then(|| {
            self.current
                .and_then(|current| self.matches.get(current))
                .is_some_and(|shown| *shown == row)
        })
    }
}

/// Whether `line` holds `query`; `fold` ignores ASCII case.
pub(super) fn holds(line: &str, query: &str, fold: bool) -> bool {
    if !fold || query.is_empty() {
        return line.contains(query);
    }
    let needle = query.as_bytes();
    line.as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

/// The rows of `files` holding `query`, in order, and whether there were
/// more than are kept.
fn search(files: &[(usize, Arc<Lines>)], query: &str) -> (Vec<RowId>, bool) {
    let fold = !query.chars().any(char::is_uppercase);
    let mut matches = Vec::new();
    for (file, lines) in files {
        for (line, found) in lines.iter().enumerate() {
            if holds(lines.text_of(found), query, fold) {
                if matches.len() == MAX_MATCHES {
                    return (matches, true);
                }
                matches.push(RowId::Line { file: *file, line });
            }
        }
    }
    (matches, false)
}

impl HerdrWindow {
    /// Opens the search field over the diff, its text selected.
    pub(crate) fn open_review_search(
        &mut self,
        id: TabId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        review.search.open = true;
        let input = review.search.input.clone();
        input.update(cx, |input, cx| {
            let text = input.text().to_owned();
            input.set_text_selected(&text, cx);
        });
        let focus = input.read(cx).focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    /// Cmd-G in a review: the next match, or the one before with `back`;
    /// with no search open yet, opens the field as Find does.
    pub(crate) fn review_find_again(
        &mut self,
        id: TabId,
        back: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let open = self
            .reviews
            .get(&id)
            .is_some_and(|review| review.search.open);
        if open {
            self.step_review_search(id, back, cx);
        } else {
            self.open_review_search(id, window, cx);
        }
    }

    fn close_review_search(&mut self, id: TabId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        review.search.open = false;
        review.search.query.clear();
        review.search.clear_results();
        let focus = review.focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    /// Searches for the field's text, as it changed.
    pub(super) fn review_query_changed(&mut self, id: TabId, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let query = review.search.input.read(cx).text().to_owned();
        review.search.query = query;
        review.search.current = None;
        self.rerun_review_search(id, cx);
    }

    /// Searches the read lines again, as they or the query changed.
    pub(super) fn rerun_review_search(&mut self, id: TabId, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let query = review.search.query.clone();
        let current = review.search.current;
        review.search.request += 1;
        if query.is_empty() {
            review.search.clear_results();
            cx.notify();
            return;
        }
        let request = review.search.request;
        let files: Vec<(usize, Arc<Lines>)> = review
            .loaded()
            .map(|loaded| {
                loaded
                    .diff
                    .files
                    .iter()
                    .enumerate()
                    .filter_map(|(index, file)| Some((index, file.lines()?.clone())))
                    .collect()
            })
            .unwrap_or_default();
        let searching = cx
            .background_executor()
            .spawn(async move { search(&files, &query) });
        cx.spawn(async move |this, cx| {
            let (matches, capped) = searching.await;
            this.update(cx, |this, cx| {
                let Some(review) = this.reviews.get_mut(&id) else {
                    return;
                };
                if review.search.request != request {
                    return;
                }
                let first = current.is_none() && !matches.is_empty();
                review.search.found = matches.iter().copied().collect();
                review.search.current = current
                    .filter(|_| !matches.is_empty())
                    .map(|current| current.min(matches.len() - 1))
                    .or(first.then_some(0));
                review.search.matches = matches;
                review.search.capped = capped;
                if first {
                    review.show_match();
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Shows the next match, or the one before with `back`.
    pub(super) fn step_review_search(&mut self, id: TabId, back: bool, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let count = review.search.matches.len();
        if count == 0 {
            return;
        }
        let next = match (review.search.current, back) {
            (None, false) => 0,
            (None, true) => count - 1,
            (Some(current), false) => (current + 1) % count,
            (Some(current), true) => (current + count - 1) % count,
        };
        review.search.current = Some(next);
        review.show_match();
        cx.notify();
    }

    /// The search field over the diff, when open.
    pub(super) fn render_review_search(
        &self,
        id: TabId,
        review: &Review,
        cx: &mut Context<Self>,
    ) -> Option<Stateful<Div>> {
        if !review.search.open {
            return None;
        }
        let theme = &self.theme;
        let search = &review.search;
        let status = match (search.matches.len(), search.current) {
            _ if search.query.is_empty() => String::new(),
            (0, _) => "No matches".into(),
            (count, current) => format!(
                "{} of {count}{}",
                current.map_or(0, |current| current + 1),
                if search.capped { "+" } else { "" }
            ),
        };
        let button = |name: &'static str, icon: &'static str| {
            div()
                .id(name)
                .debug_selector(move || name.into())
                .flex_none()
                .size(px(20.))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .rounded(px(crate::config::corners::CONTROL))
                .hover(|button| button.bg(rgb(theme.active)))
                .child(svg().path(icon).size(px(12.)).text_color(rgb(theme.muted)))
        };
        Some(
            div()
                .id("review-search")
                .debug_selector(|| "review-search".into())
                .flex_none()
                .flex()
                .items_center()
                .gap_1()
                .px_2()
                .py_1()
                .border_b_1()
                .border_color(rgb(theme.active))
                .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                    let composing = this
                        .reviews
                        .get(&id)
                        .is_some_and(|review| review.search.input.read(cx).is_composing());
                    if composing {
                        return;
                    }
                    match event.keystroke.key.as_str() {
                        "enter" => this.step_review_search(id, event.keystroke.modifiers.shift, cx),
                        "escape" => this.close_review_search(id, window, cx),
                        _ => return,
                    }
                    cx.stop_propagation();
                }))
                .child(
                    svg()
                        .path("icons/search.svg")
                        .size(px(12.))
                        .text_color(rgb(theme.muted)),
                )
                .child(div().flex_1().min_w_0().child(search.input.clone()))
                .child(div().flex_none().text_color(rgb(theme.muted)).child(status))
                .child(
                    button("review-search-previous", "icons/chevron-up.svg").on_click(
                        cx.listener(move |this, _, _, cx| this.step_review_search(id, true, cx)),
                    ),
                )
                .child(
                    button("review-search-next", "icons/chevron-down.svg").on_click(
                        cx.listener(move |this, _, _, cx| this.step_review_search(id, false, cx)),
                    ),
                )
                .child(
                    button("review-search-close", "icons/close.svg").on_click(cx.listener(
                        move |this, _, window, cx| this.close_review_search(id, window, cx),
                    )),
                ),
        )
    }
}

impl Review {
    /// Brings the current match into view, opening its file if folded.
    fn show_match(&mut self) {
        let Some(row) = self
            .search
            .current
            .and_then(|current| self.search.matches.get(current))
            .copied()
        else {
            return;
        };
        self.set_folded(row.file(), false);
        // A line or two of what comes before it shows above.
        if let Some(position) = self.position_of(row) {
            self.scroll.scroll_to(ListOffset {
                item_ix: position.saturating_sub(3),
                offset_in_item: px(0.),
            });
        }
    }
}
