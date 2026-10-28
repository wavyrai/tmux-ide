//! The review dialog: the focused checkout's changes, a note composer for
//! the line the user picked, and the queued notes with Send. Git runs on the
//! background executor; nothing reaches an agent until the user presses Send.
//! The files are listed first and their lines read afterwards, a batch at a
//! time, so a change of any size opens at once and stays responsive.
use super::{
    diff::{Anchor, Loaded, RowId, Scope},
    notes::{self, MAX_NOTES, Note},
};
use crate::browser::TabId;
use crate::{
    HerdrWindow, fonts::StyledFont, pull_request::Input, search_input::SearchInput, window::Flash,
};
use gpui::{prelude::*, *};
use herdr_client::protocol::ClientShellSnapshot;
use std::{
    cell::Cell,
    collections::{BTreeSet, HashMap, HashSet},
    rc::Rc,
};

mod colours;
mod file_rows;
mod files;
mod header;
mod keys;
mod loader;
mod model;
mod notes_panel;
mod panels;
mod rows;
mod scrollbar;
mod search;
mod selection;
mod tab;
mod tree;

/// The share of the review's width the file list and the notes may each
/// take, so a review in a narrow group keeps most of its room for the diff.
const PANEL_SHARE: f32 = 0.3;

/// How far past the view the diff lays out rows, so wrapped rows have a
/// height before they scroll in.
const OVERDRAW: f32 = 200.;

/// How the diff is drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Layout {
    /// One column, removed lines above the ones that replaced them.
    #[default]
    Unified,
    /// Before on the left, after on the right.
    Split,
}

/// The agent the notes go back to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Agent {
    pub pane_id: String,
    pub label: String,
}

/// The agent whose changes these are: the one in the focused pane, or else
/// the first in the focused workspace.
pub(crate) fn pick_agent(snapshot: &ClientShellSnapshot) -> Option<Agent> {
    let workspace = snapshot.focused_workspace_id.as_deref().or_else(|| {
        snapshot
            .workspaces
            .iter()
            .find(|workspace| workspace.focused)
            .map(|workspace| workspace.workspace_id.as_str())
    })?;
    let agent = snapshot
        .focused_pane_id
        .as_deref()
        .and_then(|pane| crate::agent_notes::agent(snapshot, pane))
        .filter(|agent| agent.workspace_id == workspace)
        .or_else(|| {
            snapshot
                .agents
                .iter()
                .find(|agent| agent.workspace_id == workspace)
        })?;
    Some(describe(agent))
}

/// The agent Herdr sees in `pane`, as a review names it.
pub(crate) fn agent_in(snapshot: &ClientShellSnapshot, pane: &str) -> Option<Agent> {
    crate::agent_notes::agent(snapshot, pane).map(describe)
}

fn describe(agent: &herdr_client::protocol::ClientShellAgent) -> Agent {
    let label = [&agent.display_agent, &agent.agent, &agent.name]
        .into_iter()
        .flatten()
        .map(|label| crate::notifications::safe_text(label, 80))
        .find(|label| !label.trim().is_empty())
        .unwrap_or_else(|| "the agent".into());
    Agent {
        pane_id: agent.pane_id.clone(),
        label,
    }
}

enum State {
    Loading,
    Loaded(Loaded),
    Failed(String),
}

pub(crate) struct Review {
    /// The checkout under review; notes belong to it.
    checkout: Input,
    /// Which of its changes show, how, and whether changes in whitespace
    /// alone count; kept between looks.
    scope: Scope,
    layout: Layout,
    ignore_whitespace: bool,
    /// The share of a side-by-side row the old side takes.
    split_ratio: f32,
    agent: Option<Agent>,
    /// The endpoint the agent's daemon was on when the review opened.
    endpoint: usize,
    state: State,
    /// Where each file's rows start in the list as drawn, then the total.
    starts: Vec<usize>,
    /// Files whose lines are being read, whether a background batch is
    /// out, and files that scrolled into view unread, read first.
    reading: HashSet<usize>,
    batch_out: bool,
    wanted: BTreeSet<usize>,
    /// Changed lines read without being scrolled to, and the file the
    /// background reading goes on from.
    eager: u64,
    cursor: usize,
    /// Hunks whose hidden lines are being read, by file and header line.
    expanding: HashSet<(usize, usize)>,
    colours: colours::Colours,
    /// Paths marked viewed, with the counts they had then: a file that
    /// changes again is no longer viewed.
    viewed: HashMap<String, (Option<u32>, Option<u32>)>,
    /// Paths the user folded or opened, over each file's default.
    folds: HashMap<String, bool>,
    /// The file list: its tree, folders closed in it, what it shows, and
    /// the line picked with the keyboard.
    tree: tree::Tree,
    closed: HashSet<String>,
    hide_viewed: bool,
    shown: Vec<usize>,
    picked: Option<usize>,
    filter: Entity<SearchInput>,
    filter_text: String,
    files_scroll: UniformListScrollHandle,
    files_focus: FocusHandle,
    /// The file last scrolled into view in the list as the diff moved.
    revealed: Cell<Option<usize>>,
    search: search::Search,
    /// The row a note is being written for.
    draft: Option<RowId>,
    /// The code selected to copy, and whether a press on the code is still
    /// being dragged to extend it.
    selection: Option<selection::Selection>,
    selecting: bool,
    notes: Vec<Note>,
    /// Each noted row and its note's number, recomputed when either changes.
    marks: HashMap<RowId, usize>,
    input: Entity<SearchInput>,
    scroll: ListState,
    /// The list width its unmeasured rows were last given a one-line
    /// height at; the list forgets heights when its width changes.
    hinted: Rc<Cell<Option<Pixels>>>,
    /// Where on the scrollbar's thumb the pointer took hold of it.
    grab: f32,
    /// Numbers loads, so only the latest one lands.
    request: u64,
    /// Holds the keyboard while the tab is used.
    focus: FocusHandle,
    /// The file list and the notes: shown or hidden by the user, or `None`
    /// to follow the review's width.
    files_shown: Option<bool>,
    notes_shown: Option<bool>,
    /// The review's width at its last layout, which decides that.
    width: Rc<Cell<f32>>,
    /// The checkout's status when the review last read it: a change reads
    /// the review again.
    seen: Option<crate::git::Status>,
    /// Where the view was before a reload, to return to.
    restore: Option<Anchor>,
    /// The filter's and the search field's edits, followed while it lives.
    _subscriptions: Vec<Subscription>,
}

impl Review {
    fn loaded(&self) -> Option<&Loaded> {
        match &self.state {
            State::Loaded(loaded) => Some(loaded),
            _ => None,
        }
    }

    fn loaded_mut(&mut self) -> Option<&mut Loaded> {
        match &mut self.state {
            State::Loaded(loaded) => Some(loaded),
            _ => None,
        }
    }

    /// Shows `loaded`, folding and marking files as the user left them.
    fn set_loaded(&mut self, mut loaded: Loaded) {
        for file in &mut loaded.diff.files {
            let viewed = self.viewed.get(&file.path) == Some(&(file.added, file.removed));
            file.folded = self
                .folds
                .get(&file.path)
                .copied()
                .unwrap_or(file.folded || viewed);
        }
        self.viewed.retain(|path, counts| {
            loaded
                .diff
                .files
                .iter()
                .any(|file| file.path == *path && (file.added, file.removed) == *counts)
        });
        self.tree = tree::Tree::build(&loaded.diff);
        self.state = State::Loaded(loaded);
        self.reading.clear();
        self.wanted.clear();
        self.batch_out = false;
        self.eager = 0;
        self.cursor = 0;
        self.expanding.clear();
        self.colours = colours::Colours::default();
        self.selection = None;
        self.search.clear_results();
        self.picked = None;
        self.revealed.set(None);
        self.rebuild_starts();
        self.reset_scroll(0);
    }

    /// Lists the rows of the current layout afresh, with list position
    /// `top` at the top.
    fn reset_scroll(&mut self, top: usize) {
        self.scroll.reset(self.row_count());
        self.hinted.set(None);
        self.scroll.scroll_to(ListOffset {
            item_ix: top,
            offset_in_item: px(0.),
        });
    }

    fn row_count(&self) -> usize {
        self.starts.last().copied().unwrap_or(0)
    }

    fn is_viewed(&self, file: usize) -> bool {
        self.loaded()
            .and_then(|loaded| loaded.diff.files.get(file))
            .is_some_and(|file| self.viewed.get(&file.path) == Some(&(file.added, file.removed)))
    }

    fn refresh_marks(&mut self) {
        let mut marks = HashMap::new();
        if let Some(loaded) = self.loaded() {
            let paths = loaded.diff.paths();
            for (index, note) in self.notes.iter().enumerate() {
                if let Some(row) = loaded.diff.row_of(&paths, &note.anchor) {
                    marks.entry(row).or_insert(index + 1);
                }
            }
        }
        self.marks = marks;
    }
}

impl HerdrWindow {
    /// The height of one line of the diff.
    fn review_line_height(&self) -> f32 {
        self.config.terminal.line_height().max(14.)
    }

    /// Lists the review's changes again in its scope, off the UI thread,
    /// then reads their lines. Only the latest load lands.
    fn load_review(&mut self, id: TabId, cx: &mut Context<Self>) {
        // The pull request's base, when GitHub reported one for this branch.
        let base_hint = self.git_pull_request().map(|pr| pr.base_ref_name.clone());
        let status = self.git.status();
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        review.request += 1;
        review.state = State::Loading;
        review.draft = None;
        review.seen = status;
        let (request, checkout, scope, whitespace) = (
            review.request,
            review.checkout.clone(),
            review.scope,
            review.ignore_whitespace,
        );
        let loading = cx.background_executor().spawn(async move {
            super::diff::load(&checkout, scope, base_hint.as_deref(), whitespace)
        });
        cx.spawn(async move |this, cx| {
            let result = loading.await;
            this.update(cx, |this, cx| {
                this.review_loaded(id, request, result);
                this.schedule_review_reads(id, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Reads the review again where it stands, keeping the place it shows
    /// and the files folded.
    fn reload_review(&mut self, id: TabId, cx: &mut Context<Self>) {
        if let Some(review) = self.reviews.get_mut(&id) {
            review.restore = review
                .top_row()
                .and_then(|row| review.loaded()?.diff.anchor(row));
        }
        self.load_review(id, cx);
    }

    /// Shows uncommitted changes or the whole branch; queued notes stay.
    pub(crate) fn set_review_scope(&mut self, id: TabId, scope: Scope, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        if review.scope == scope {
            return;
        }
        review.scope = scope;
        self.load_review(id, cx);
    }

    /// Leaves changes in whitespace alone out of the review, or back in.
    pub(crate) fn toggle_review_whitespace(&mut self, id: TabId, cx: &mut Context<Self>) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        review.ignore_whitespace = !review.ignore_whitespace;
        self.reload_review(id, cx);
    }

    /// Reads a review again when the checkout's changes moved since it
    /// last read them, unless a note is being written on a line.
    pub(crate) fn follow_review_changes(&mut self, cx: &mut Context<Self>) {
        let (Some(tracked), Some(status)) = (self.git.tracked().cloned(), self.git.status()) else {
            return;
        };
        let mut moved = Vec::new();
        for (id, review) in &mut self.reviews {
            if review.checkout != tracked {
                continue;
            }
            match review.seen {
                None => review.seen = Some(status),
                Some(seen)
                    if seen != status
                        && review.draft.is_none()
                        && matches!(review.state, State::Loaded(_)) =>
                {
                    moved.push(*id);
                }
                Some(_) => {}
            }
        }
        for id in moved {
            self.reload_review(id, cx);
        }
    }

    /// Opens a review tab in workspace `w0` on `loaded`, as if Git had
    /// just listed it, shown in the group in use. Its tab.
    #[cfg(test)]
    #[allow(clippy::expect_used)]
    pub(super) fn seed_review(
        &mut self,
        loaded: Loaded,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> TabId {
        let scope = crate::browser::scope(&self.endpoints[self.selected_endpoint]);
        let checkout = crate::browser::ReviewCheckout {
            repo_key: "/work/repo/.git".into(),
            branch: "feature".into(),
            checkout: Some("/work/repo".into()),
        };
        let agent = self.live.snapshot.as_deref().and_then(pick_agent);
        let origin = agent.as_ref().map(|agent| agent.pane_id.clone());
        let input_checkout = Input::from(&checkout);
        let id = crate::browser::Store::update(cx, |store| {
            store.open(
                scope,
                "w0",
                Some(crate::browser::Location::Review { checkout }),
                origin,
            )
        })
        .expect("a tab");
        let mut review = self.new_review(id, input_checkout, agent, cx);
        review.scope = loaded.scope;
        review.request = 1;
        review.set_loaded(loaded);
        review.refresh_shown();
        self.reviews.insert(id, review);
        self.show_browser_tab(id, window, cx);
        id
    }

    fn review_loaded(&mut self, id: TabId, request: u64, result: crate::Result<Loaded>) {
        let Some(review) = self
            .reviews
            .get_mut(&id)
            .filter(|review| review.request == request)
        else {
            return;
        };
        match result {
            Ok(loaded) => review.set_loaded(loaded),
            Err(error) => {
                tracing::warn!(%error, "Could not read the changes to review");
                review.state = State::Failed(error.to_string());
            }
        }
        review.refresh_marks();
        review.refresh_shown();
        // Back to the file the view was on; its line once it is read.
        let file = review.restore.as_ref().and_then(|anchor| {
            let (Anchor::File { path } | Anchor::Line { path, .. }) = anchor;
            review.loaded()?.diff.paths().get(path.as_str()).copied()
        });
        match file {
            Some(file) => review.scroll_to_row(RowId::Header(file)),
            None => review.restore = None,
        }
    }

    /// Starts a note on `row`, typed in the composer.
    pub(crate) fn begin_review_note(
        &mut self,
        id: TabId,
        row: RowId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        if review.notes.len() >= MAX_NOTES {
            self.show_flash(
                Flash::warning("Send or remove notes before adding more"),
                cx,
            );
            return;
        }
        if review
            .loaded()
            .is_none_or(|loaded| loaded.diff.anchor(row).is_none())
        {
            return;
        }
        review.draft = Some(row);
        let input = review.input.clone();
        input.update(cx, |input, cx| input.clear(cx));
        let focus = input.read(cx).focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    pub(crate) fn add_review_note(
        &mut self,
        id: TabId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(review) = self.reviews.get_mut(&id) else {
            return;
        };
        let text = review.input.read(cx).text().to_owned();
        let Some(anchor) = review
            .draft
            .zip(review.loaded())
            .and_then(|(row, loaded)| loaded.diff.anchor(row))
        else {
            return;
        };
        let Some(note) = Note::new(anchor, &text) else {
            self.show_flash(Flash::warning("Write what should change first"), cx);
            return;
        };
        review.notes.push(note);
        review.draft = None;
        review.refresh_marks();
        review.input.update(cx, |input, cx| input.clear(cx));
        let focus = review.focus.clone();
        window.focus(&focus, cx);
        cx.notify();
    }

    fn cancel_review_note(&mut self, id: TabId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(review) = self.reviews.get_mut(&id) {
            review.draft = None;
            let focus = review.focus.clone();
            window.focus(&focus, cx);
        }
        cx.notify();
    }

    fn remove_review_note(&mut self, id: TabId, index: usize, cx: &mut Context<Self>) {
        if let Some(review) = self.reviews.get_mut(&id)
            && index < review.notes.len()
        {
            review.notes.remove(index);
            review.refresh_marks();
        }
        cx.notify();
    }

    /// The queued notes as the agent's prompt, with where they go.
    fn review_prompt(&self, id: TabId) -> Option<(String, Option<String>, bool)> {
        let review = self.reviews.get(&id)?;
        let loaded = review.loaded()?;
        if review.notes.is_empty() {
            return None;
        }
        let text = notes::prompt(&loaded.source.checkout, &review.notes);
        let pane = review.agent.as_ref().map(|agent| agent.pane_id.clone());
        Some((text, pane, review.endpoint == self.selected_endpoint))
    }

    /// Sends the notes to the agent; the queue is cleared at once so a
    /// second press cannot repeat it. The tab stays open for the next round.
    pub(crate) fn send_review(&mut self, id: TabId, cx: &mut Context<Self>) {
        let Some((text, pane, here)) = self.review_prompt(id) else {
            return;
        };
        if let Some(review) = self.reviews.get_mut(&id) {
            review.notes.clear();
            review.refresh_marks();
        }
        self.deliver_notes(pane, here, text, cx);
        cx.notify();
    }

    fn copy_review(&mut self, id: TabId, cx: &mut Context<Self>) {
        let Some((text, _, _)) = self.review_prompt(id) else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.show_flash(Flash::success("Notes copied"), cx);
    }

    pub(crate) fn render_review(&self, id: TabId, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme.clone();
        let Some(review) = self.reviews.get(&id) else {
            return div().into_any_element();
        };
        let line_height = self.review_line_height();
        let body = match &review.state {
            State::Loading => div()
                .p_3()
                .text_color(rgb(theme.muted))
                .child("Reading changes\u{2026}")
                .into_any_element(),
            State::Failed(error) => div()
                .debug_selector(|| "review-error".into())
                .p_3()
                .text_color(crate::menu::danger(&theme))
                .child(error.clone())
                .into_any_element(),
            State::Loaded(loaded) if loaded.diff.files.is_empty() => div()
                .p_3()
                .text_color(rgb(theme.muted))
                .child(match loaded.scope {
                    Scope::Uncommitted => "No uncommitted changes",
                    Scope::Branch => "No changes on this branch",
                })
                .into_any_element(),
            State::Loaded(_) => div()
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .text_font(&self.config.terminal)
                .text_size(px(self.config.terminal.size))
                .children(self.render_review_search(id, review, cx))
                .child(
                    self.review_scroll_area(
                        id,
                        list(
                            review.scroll.clone(),
                            cx.processor(move |this, position: usize, _, cx| {
                                this.review_row(id, position, line_height, cx)
                            }),
                        )
                        .flex_1()
                        .min_h_0(),
                        cx,
                    ),
                )
                .into_any_element(),
        };
        let has_files = review
            .loaded()
            .is_some_and(|loaded| !loaded.diff.files.is_empty());
        div()
            .id("review")
            .debug_selector(|| "review".into())
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .child(panels::measure(review.width.clone()))
            .child(self.render_review_header(id, review, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .when(has_files && review.shows(panels::Panel::Files), |row| {
                        row.child(self.render_review_files(id, review, cx))
                    })
                    .child(div().flex_1().min_w_0().flex().flex_col().child(body))
                    .when(review.shows(panels::Panel::Notes), |row| {
                        row.child(self.render_review_notes(id, review, cx))
                    }),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests;
