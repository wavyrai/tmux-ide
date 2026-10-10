//! Where a new worktree comes from: a branch typed by hand, a checkout Herdr
//! has not opened yet, a branch without a checkout, an open pull request, or
//! an open issue. One search field above the tabs filters every listing at
//! once; picking a row opens or creates the checkout, and a GitHub row leaves a
//! note in it naming the pull request or issue it is for.

use super::{Page, WorkspaceAction, worktree_open::Entry};
use crate::{
    HerdrWindow,
    repo_items::{self, Branch, Item, Kind},
    search_input::SearchInput,
};
use gpui::{Entity, Subscription, Task, UniformListScrollHandle, prelude::*};
use herdr_client::Method;

/// Which part of the new worktree dialog is showing. A closed set: the tab
/// strip, the key routing, and the panel geometry all match on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tab {
    /// The branch field and the checkout it previews.
    New,
    /// Checkouts of this repository that no Herdr workspace has open.
    Existing,
    /// Local branches no checkout has.
    Branches,
    /// A listing of the repository's open pull requests or issues.
    Items(Kind),
}

impl Tab {
    pub(super) const ALL: [Self; 5] = [
        Self::New,
        Self::Existing,
        Self::Branches,
        Self::Items(Kind::PullRequest),
        Self::Items(Kind::Issue),
    ];

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Existing => "existing",
            Self::Branches => "branch",
            Self::Items(kind) => kind.tab_label(),
        }
    }

    pub(super) fn kind(self) -> Option<Kind> {
        match self {
            Self::Items(kind) => Some(kind),
            Self::New | Self::Existing | Self::Branches => None,
        }
    }

    fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|tab| *tab == self)
            .unwrap_or_default()
    }
}

/// What a picked row is opening or creating, held from the pick until the
/// daemon answers so the status line, the note and a refusal can name it.
#[derive(Clone, Debug)]
pub(super) enum Pending {
    /// A pull request or issue; its checkout gets a note naming it.
    Item(Item),
    Branch(Branch),
    /// The path of an existing checkout the daemon is asked to open.
    Checkout(String),
}

impl Pending {
    pub(super) fn label(&self) -> String {
        match self {
            Self::Item(item) => item.label(),
            Self::Branch(branch) => branch.name.clone(),
            Self::Checkout(path) => path.clone(),
        }
    }

    /// Opening answers with `worktree_opened` rather than `worktree_created`.
    pub(super) fn opens(&self) -> bool {
        matches!(self, Self::Checkout(_))
    }
}

/// One visible row of a listing tab.
pub(super) enum Row<'a> {
    Checkout(&'a Entry),
    Branch(&'a Branch),
    Item(&'a Item),
}

/// The daemon's worktree list, kept to the checkouts no workspace has open.
#[derive(Default)]
pub(super) struct Checkouts {
    /// The correlated `worktree.list`, until the daemon answers.
    pub(super) request: Option<String>,
    pub(super) entries: Vec<Entry>,
    pub(super) listed: bool,
    pub(super) message: Option<String>,
}

/// The repository's branches without a checkout, read on a background task.
/// Dropping the dialog drops the task, so a late answer has nowhere to land.
#[derive(Default)]
pub(super) struct Branches {
    pub(super) entries: Vec<Branch>,
    pub(super) loading: bool,
    pub(super) listed: bool,
    pub(super) message: Option<String>,
    task: Option<Task<()>>,
}

/// The dialog's tab state and the listings behind its tabs.
pub(crate) struct WorktreeSource {
    pub(super) tab: Tab,
    pub(super) search: Entity<SearchInput>,
    /// The workspace name for a typed branch. Left empty, the daemon keeps its
    /// own default label.
    pub(super) name: Entity<SearchInput>,
    /// Indices into the open tab's listing, in listed order.
    pub(super) filtered: Vec<usize>,
    /// How many rows the search keeps in each tab, in `Tab::ALL` order.
    hits: [usize; Tab::ALL.len()],
    pub(super) selected: usize,
    pub(super) scroll: UniformListScrollHandle,
    /// The search, trimmed and lowercased once for every listing.
    query: String,
    pub(super) lookup: repo_items::Lookup,
    pub(super) checkouts: Checkouts,
    pub(super) branches: Branches,
    /// The row a creation is running for, kept from the moment it is picked
    /// until the daemon answers.
    pub(super) pending: Option<Pending>,
    _subscription: Subscription,
}

impl WorktreeSource {
    /// Search every listing for `query` and rebuild the open tab's rows.
    /// Checkouts match on path, label and branch; GitHub rows on number, title
    /// and author, as the theme picker matches names.
    pub(super) fn filter(&mut self, query: &str) {
        self.query = query.trim().to_lowercase();
        self.refresh();
    }

    /// Rerun the current search after a listing arrived or the tab changed.
    pub(super) fn refresh(&mut self) {
        for tab in Tab::ALL {
            self.hits[tab.index()] = self.matching(tab).len();
        }
        self.filtered = self.matching(self.tab);
        self.selected = 0;
        self.scroll.scroll_to_item(0, gpui::ScrollStrategy::Top);
    }

    fn matching(&self, tab: Tab) -> Vec<usize> {
        let query = self.query.as_str();
        let keep = |(index, matched): (usize, bool)| matched.then_some(index);
        match tab {
            Tab::New => Vec::new(),
            Tab::Existing => self
                .checkouts
                .entries
                .iter()
                .map(|entry| entry.matches(query))
                .enumerate()
                .filter_map(keep)
                .collect(),
            Tab::Branches => self
                .branches
                .entries
                .iter()
                .map(|branch| branch.matches(query))
                .enumerate()
                .filter_map(keep)
                .collect(),
            Tab::Items(kind) => self
                .lookup
                .items
                .iter()
                .map(|item| {
                    item.kind == kind && (query.is_empty() || item.search_key().contains(query))
                })
                .enumerate()
                .filter_map(keep)
                .collect(),
        }
    }

    pub(super) fn row(&self, row: usize) -> Option<Row<'_>> {
        let index = *self.filtered.get(row)?;
        match self.tab {
            Tab::New => None,
            Tab::Existing => self.checkouts.entries.get(index).map(Row::Checkout),
            Tab::Branches => self.branches.entries.get(index).map(Row::Branch),
            Tab::Items(_) => self.lookup.items.get(index).map(Row::Item),
        }
    }

    pub(super) fn item(&self, row: usize) -> Option<&Item> {
        match self.row(row)? {
            Row::Item(item) => Some(item),
            Row::Checkout(_) | Row::Branch(_) => None,
        }
    }

    /// How many of `tab`'s rows the search kept, once its listing has arrived.
    pub(super) fn hits(&self, tab: Tab) -> Option<usize> {
        let listed = match tab {
            Tab::New => false,
            Tab::Existing => self.checkouts.listed,
            Tab::Branches => self.branches.listed,
            Tab::Items(_) => self.lookup.listed(),
        };
        listed.then(|| self.hits[tab.index()])
    }

    /// How many of the open tab's listed rows the search kept, and how many
    /// there were, for the count line above the list.
    pub(super) fn counts(&self) -> (usize, usize) {
        let total = match self.tab {
            Tab::New => 0,
            Tab::Existing => self.checkouts.entries.len(),
            Tab::Branches => self.branches.entries.len(),
            Tab::Items(kind) => self
                .lookup
                .items
                .iter()
                .filter(|item| item.kind == kind)
                .count(),
        };
        (self.filtered.len(), total)
    }

    /// A creation is under way, so the list must not start another.
    pub(super) fn busy(&self) -> bool {
        self.pending.is_some()
    }

    /// Keep what the daemon listed that no workspace has open yet.
    fn apply_checkouts(&mut self, result: crate::state::DialogResponse) {
        self.checkouts.request = None;
        match result {
            Err(error) => self.checkouts.message = Some(error.to_string()),
            Ok(response) => {
                if let Some(error) = response.get("error") {
                    let (code, message) = super::endpoint_error(error);
                    self.checkouts.message = Some(format!("{code}: {message}"));
                } else {
                    match super::worktree_open::listing(&response) {
                        Ok((_, entries)) => {
                            self.checkouts.entries = entries
                                .into_iter()
                                .filter(|entry| entry.open_workspace_id.is_none())
                                .collect();
                            self.checkouts.listed = true;
                            self.checkouts.message = None;
                        }
                        Err(error) => self.checkouts.message = Some(error.to_string()),
                    }
                }
            }
        }
        self.refresh();
    }

    /// A correlated request replaces the window's one dialog answer slot, so a
    /// listing still in flight can no longer be answered and is asked again.
    pub(super) fn superseded(&mut self) {
        self.checkouts.request = None;
    }
}

impl HerdrWindow {
    /// Whether the new worktree dialog is showing one of its listings rather
    /// than the branch form. Geometry, key routing and input isolation all
    /// branch on this.
    pub(crate) fn worktree_listing(&self) -> bool {
        self.menu.page == Some(Page::Dialog(WorkspaceAction::NewWorktree))
            && self
                .menu
                .worktree
                .as_ref()
                .is_some_and(|source| source.tab != Tab::New)
    }

    /// Whether the shared search field has focus, so typing belongs to it even
    /// while the branch form is showing.
    pub(crate) fn worktree_search_focused(&self, window: &gpui::Window, cx: &gpui::App) -> bool {
        self.menu.page == Some(Page::Dialog(WorkspaceAction::NewWorktree))
            && self
                .menu
                .worktree
                .as_ref()
                .is_some_and(|source| source.search.read(cx).focus.is_focused(window))
    }

    /// Whether the branch form's name field has focus, so its typing, Enter
    /// aside, never reaches the branch draft.
    pub(crate) fn worktree_name_focused(&self, window: &gpui::Window, cx: &gpui::App) -> bool {
        self.menu.page == Some(Page::Dialog(WorkspaceAction::NewWorktree))
            && self
                .menu
                .worktree
                .as_ref()
                .is_some_and(|source| source.name.read(cx).focus.is_focused(window))
    }

    /// The trimmed name typed for the new workspace, when there is one.
    pub(super) fn worktree_name(&self, cx: &gpui::App) -> Option<String> {
        let source = self.menu.worktree.as_ref()?;
        let name = source.name.read(cx).text().trim();
        (!name.is_empty()).then(|| name.to_owned())
    }

    pub(super) fn open_worktree_source(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        let search = cx.new(SearchInput::new);
        search.update(cx, |input, cx| {
            input.set_placeholder("Search checkouts, branches, pull requests, issues...", cx);
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
        });
        let subscription = cx.subscribe_in(
            &search,
            window,
            |this, search, _: &crate::search_input::Changed, window, cx| {
                let text = search.read(cx).text().to_owned();
                this.search_worktree_sources(&text, window, cx);
            },
        );
        let name = cx.new(SearchInput::new);
        name.update(cx, |input, cx| {
            input.set_placeholder("Default name", cx);
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
        });
        // The name is what most people change, so the form opens on it.
        window.focus(&name.read(cx).focus.clone(), cx);
        self.menu.worktree = Some(WorktreeSource {
            tab: Tab::New,
            search,
            name,
            filtered: Vec::new(),
            hits: Default::default(),
            selected: 0,
            scroll: UniformListScrollHandle::new(),
            query: String::new(),
            lookup: Default::default(),
            checkouts: Default::default(),
            branches: Default::default(),
            pending: None,
            _subscription: subscription,
        });
        // Both are cheap and local, so their counts are ready before a tab is
        // opened; GitHub waits for its tab or the first search.
        self.list_checkouts();
        self.list_branches(cx);
    }

    /// Apply a change to the shared search. It searches every listing, so the
    /// GitHub one is started by the first search rather than waiting for its
    /// tab, and typing into it from the branch form moves to the first tab
    /// that matched.
    fn search_worktree_sources(
        &mut self,
        text: &str,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = &mut self.menu.worktree else {
            return;
        };
        source.filter(text);
        let searching = !source.query.is_empty();
        let jump = (source.tab == Tab::New && searching)
            .then(|| {
                Tab::ALL
                    .into_iter()
                    .find(|tab| source.hits(*tab).is_some_and(|hits| hits > 0))
            })
            .flatten();
        if searching {
            if !source.checkouts.listed {
                self.list_checkouts();
            }
            if self.menu.github.connected() {
                self.list_repo_items();
            }
        }
        if let Some(tab) = jump {
            self.select_worktree_tab(tab, window, cx);
        }
        cx.notify();
    }

    /// Move to `tab`, focusing whichever field that tab types into and starting
    /// its listing if it has none yet.
    pub(super) fn select_worktree_tab(
        &mut self,
        tab: Tab,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) {
        if tab.kind().is_some() && !self.menu.github.connected() {
            return;
        }
        let Some(source) = &mut self.menu.worktree else {
            return;
        };
        if source.busy() {
            return;
        }
        source.tab = tab;
        source.refresh();
        let search = source.search.clone();
        let name = source.name.clone();
        let retry_branches = !source.branches.listed && !source.branches.loading;
        let list_checkouts = !source.checkouts.listed && source.checkouts.request.is_none();
        match tab {
            Tab::New => window.focus(&name.read(cx).focus.clone(), cx),
            Tab::Existing => {
                if list_checkouts {
                    self.list_checkouts();
                }
                window.focus(&search.read(cx).focus.clone(), cx);
            }
            Tab::Branches => {
                if retry_branches {
                    self.list_branches(cx);
                }
                window.focus(&search.read(cx).focus.clone(), cx);
            }
            Tab::Items(_) => {
                window.focus(&search.read(cx).focus.clone(), cx);
                self.list_repo_items();
            }
        }
        cx.notify();
    }

    /// Ask the daemon for the repository's checkouts. The answer comes through
    /// the window's one correlated dialog slot, so nothing is asked while a
    /// creation or a removal is still waiting on it.
    fn list_checkouts(&mut self) {
        if self.menu.creation.is_some()
            || self
                .removal
                .as_ref()
                .is_some_and(|removal| removal.pending.is_some())
        {
            return;
        }
        let result = (|| {
            if !self.menu_target_current() {
                return Err(crate::Error::StaleConnection);
            }
            if !self.live.status.is_connected() {
                return Err(crate::Error::NotConnected);
            }
            let target = self
                .menu
                .target
                .as_ref()
                .ok_or(crate::Error::StaleWorkspace)?;
            self.endpoints[self.selected_endpoint]
                .connection
                .request_dialog(
                    &target.boot_id,
                    Method::WorktreeList,
                    serde_json::json!({"workspace_id": target.id, "trust_repository": false}),
                )
        })();
        let Some(source) = &mut self.menu.worktree else {
            return;
        };
        match result {
            Ok(id) => {
                source.checkouts.request = Some(id);
                source.checkouts.message = None;
            }
            Err(error) => source.checkouts.message = Some(error.to_string()),
        }
    }

    /// Apply the daemon's worktree list when it is the answer the dialog is
    /// waiting for.
    pub(super) fn apply_checkout_list(&mut self, cx: &mut Context<Self>) {
        let Some(source) = &mut self.menu.worktree else {
            return;
        };
        let Some(request) = source.checkouts.request.as_deref() else {
            return;
        };
        let Some((id, Some(result))) = &self.live.dialog_response else {
            return;
        };
        if id != request {
            return;
        }
        source.apply_checkouts(result.clone());
        cx.notify();
    }

    /// Read the repository's branches off the UI thread. Local Git only reads
    /// a repository on this machine, so it is limited to the owned local
    /// daemon, as the GitHub listings are.
    fn list_branches(&mut self, cx: &mut Context<Self>) {
        let input = self.local_repository_input();
        let Some(source) = &mut self.menu.worktree else {
            return;
        };
        let input = match input {
            Ok(input) => input,
            Err(error) => {
                source.branches.message = Some(error.to_string());
                return;
            }
        };
        let work = cx
            .background_executor()
            .spawn(async move { repo_items::list_branches(&input, &|| false) });
        source.branches.loading = true;
        source.branches.message = None;
        source.branches.task = Some(cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                let Some(source) = &mut this.menu.worktree else {
                    return;
                };
                let branches = &mut source.branches;
                branches.loading = false;
                match result {
                    Ok(entries) => {
                        branches.entries = entries;
                        branches.listed = true;
                    }
                    Err(error) => branches.message = Some(error.to_string()),
                }
                source.refresh();
                cx.notify();
            });
        }));
    }

    /// Ask for the repository's open pull requests and issues. One listing
    /// serves both tabs, and it is only requested once per opened dialog.
    fn list_repo_items(&mut self) {
        let Some(source) = &self.menu.worktree else {
            return;
        };
        if source.lookup.listed() || source.lookup.loading {
            return;
        }
        match self.repo_items_request() {
            Ok((input, token)) => {
                if let Some(source) = &mut self.menu.worktree {
                    source.lookup.list(input, token);
                }
            }
            Err(error) => {
                if let Some(source) = &mut self.menu.worktree {
                    source.lookup.message = Some(error.to_string());
                }
            }
        }
    }

    /// The repository to read locally, under the same endpoint and staleness
    /// rules the PR section already enforces. A workspace the daemon has no
    /// worktree metadata for is read from its own directory.
    fn local_repository_input(&self) -> crate::Result<crate::pull_request::Input> {
        if self.menu.target.is_none() || !self.menu_target_current() {
            return Err(crate::Error::StaleWorkspace);
        }
        if self.selected_endpoint != 0 || !self.live.local_daemon_peer {
            return Err(crate::Error::PrUntrustedEndpoint);
        }
        let workspace = self
            .menu_target_workspace()
            .ok_or(crate::Error::StaleWorkspace)?;
        crate::pull_request::workspace_input(workspace, &crate::pull_request::Origin::Local)
    }

    /// The checkout to read and the token to read GitHub with.
    fn repo_items_request(
        &self,
    ) -> crate::Result<(
        crate::pull_request::Input,
        std::sync::Arc<secrecy::SecretString>,
    )> {
        let input = self.local_repository_input()?;
        let token = self
            .menu
            .github
            .profile
            .as_ref()
            .map(|profile| profile.token.clone())
            .ok_or(crate::Error::GitHubAuthentication)?;
        Ok((input, token))
    }

    /// Open or create whatever the row at `row` of the open listing names.
    pub(super) fn pick_worktree_row(&mut self, row: usize, cx: &mut Context<Self>) {
        let Some(source) = &mut self.menu.worktree else {
            return;
        };
        if source.busy() || self.menu.creation.is_some() {
            return;
        }
        let pending = match source.row(row) {
            None => return,
            Some(Row::Item(_)) => return self.create_from_repo_item(row, cx),
            Some(Row::Branch(branch)) => Pending::Branch(branch.clone()),
            Some(Row::Checkout(entry)) => Pending::Checkout(entry.path.clone()),
        };
        source.pending = Some(pending.clone());
        self.menu.error = None;
        self.submit_pick(&pending, cx);
    }

    /// Create a checkout for the row at `row` of the open tab. A pull request
    /// branch is made reachable first; an issue's branch is new, so its
    /// creation is queued straight away.
    pub(super) fn create_from_repo_item(&mut self, row: usize, cx: &mut Context<Self>) {
        let Some(source) = &self.menu.worktree else {
            return;
        };
        if source.busy() || self.menu.creation.is_some() {
            return;
        }
        let Some(item) = source.item(row).cloned() else {
            return;
        };
        self.menu.error = None;
        match (item.head.clone(), self.repo_items_request()) {
            // An existing pull request branch may only exist on the remote, so
            // its base ref is refreshed before the daemon is asked for it.
            (Some(_), Ok((input, token))) => {
                if let Some(source) = &mut self.menu.worktree {
                    source.lookup.fetch_branch(input, token, &item);
                    source.pending = Some(Pending::Item(item));
                }
                cx.notify();
            }
            (Some(_), Err(error)) => {
                self.menu.error = Some(error.to_string());
                cx.notify();
            }
            (None, _) => {
                let pending = Pending::Item(item);
                if let Some(source) = &mut self.menu.worktree {
                    source.pending = Some(pending.clone());
                }
                self.submit_pick(&pending, cx);
            }
        }
    }

    /// Queue the daemon request for a picked row, under the same fences a
    /// typed branch submission uses.
    fn submit_pick(&mut self, pending: &Pending, cx: &mut Context<Self>) {
        let result = (|| {
            if !self.menu_target_current() {
                return Err(crate::Error::StaleConnection);
            }
            if !self.live.status.is_connected() {
                return Err(crate::Error::NotConnected);
            }
            let target = self
                .menu
                .target
                .as_ref()
                .ok_or(crate::Error::StaleWorkspace)?;
            let snapshot = self
                .live
                .snapshot
                .as_ref()
                .ok_or(crate::Error::NoSnapshot)?;
            let (method, params) = pick_request(target, snapshot, pending)?;
            self.endpoints[self.selected_endpoint]
                .connection
                .request_dialog(&target.boot_id, method, params)
        })();
        match result {
            Ok(id) => {
                self.menu.creation = Some(id);
                self.menu.error = None;
                self.local_error = None;
                if let Some(source) = &mut self.menu.worktree {
                    source.superseded();
                }
                self.fence_focus_change(None);
                cx.notify();
            }
            Err(error) => {
                if let Some(source) = &mut self.menu.worktree {
                    source.pending = None;
                }
                self.menu.error = Some(error.to_string());
                cx.notify();
            }
        }
    }

    /// Drain the listing worker: report what it found, and queue the creation a
    /// finished branch fetch was preparing for.
    pub(crate) fn poll_worktree_source(&mut self, cx: &mut Context<Self>) {
        let Some(source) = &mut self.menu.worktree else {
            return;
        };
        if !source.lookup.poll() {
            return;
        }
        let ready = source.lookup.ready.take();
        source.refresh();
        let pending = match (ready, &source.pending) {
            // The fetch succeeded for the branch that is still being created.
            (Some(branch), Some(Pending::Item(item))) if item.branch() == branch => {
                source.pending.clone()
            }
            (Some(_), _) => None,
            (None, _) => {
                // A failed fetch leaves nothing to create; its message is shown.
                if source.lookup.message.is_some()
                    && matches!(source.pending, Some(Pending::Item(_)))
                {
                    source.pending = None;
                }
                None
            }
        };
        match pending {
            Some(pending) => self.submit_pick(&pending, cx),
            None => cx.notify(),
        }
    }

    /// Write the note naming what the created checkout is for. The daemon owns
    /// the checkout, so its own reported path is used rather than a guess, and
    /// the write itself is file I/O and never runs on the UI thread.
    pub(super) fn write_worktree_note(
        &mut self,
        response: &serde_json::Value,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = &mut self.menu.worktree else {
            return;
        };
        let (Some(Pending::Item(item)), Some(origin)) =
            (source.pending.take(), source.lookup.origin.clone())
        else {
            return;
        };
        let Some(checkout) = response["workspace"]["worktree"]["checkout_path"]
            .as_str()
            .filter(|path| std::path::Path::new(path).is_absolute())
            .map(std::path::PathBuf::from)
        else {
            self.local_error = Some("The daemon did not report the new checkout path, so no agent context note was written.".into());
            return;
        };
        let write = cx
            .background_executor()
            .spawn(async move { repo_items::write_context(&checkout, &item, &origin) });
        cx.spawn(async move |this, cx| {
            let result = write.await;
            let _ = this.update(cx, |this, cx| {
                if let Err(error) = result {
                    this.local_error = Some(error.to_string());
                    cx.notify();
                }
            });
        })
        .detach();
    }
}

/// The request a picked row makes: an existing checkout is opened, anything
/// else goes through the same `worktree.create` validation a typed branch does.
pub(super) fn pick_request(
    target: &super::WorkspaceTarget,
    snapshot: &herdr_client::protocol::ClientShellSnapshot,
    pending: &Pending,
) -> crate::Result<(Method, serde_json::Value)> {
    match pending {
        Pending::Item(item) => item_request(target, snapshot, item),
        Pending::Branch(branch) => {
            target.request(snapshot, WorkspaceAction::NewWorktree, &branch.name)
        }
        Pending::Checkout(path) => target.request(snapshot, WorkspaceAction::OpenWorktree, path),
    }
}

/// The `worktree.create` a picked row asks for. It goes through the same
/// validation a typed branch does; only the base and the label differ, and
/// neither widens what may be created.
///
/// A pull request's head may exist only on `origin`, so its base names the
/// ref the fetch just updated (a dedicated PR ref for forks). The daemon checks out a branch
/// that already exists locally and ignores the base in that case. An issue's
/// branch is new, so it keeps the dialog's default base of `HEAD`.
pub(super) fn item_request(
    target: &super::WorkspaceTarget,
    snapshot: &herdr_client::protocol::ClientShellSnapshot,
    item: &Item,
) -> crate::Result<(Method, serde_json::Value)> {
    let branch = item.branch();
    let (method, mut params) = target.request(snapshot, WorkspaceAction::NewWorktree, &branch)?;
    if item.head.is_some() {
        params["base"] = item.base_ref().into();
    }
    // The checkout is named for what it is for, so the sidebar shows it too.
    params["label"] = item.label().into();
    Ok((method, params))
}

/// Finished listings, for tests that drive the tabs without a network, a
/// daemon or a repository.
#[cfg(test)]
impl WorktreeSource {
    pub(crate) fn install(&mut self, origin: repo_items::Origin, items: Vec<Item>) {
        self.lookup.origin = Some(origin);
        self.lookup.items = items;
        self.lookup.loading = false;
        self.refresh();
    }

    pub(crate) fn install_branches(&mut self, branches: Vec<Branch>) {
        self.branches = Branches {
            entries: branches,
            listed: true,
            ..Default::default()
        };
        self.refresh();
    }

    pub(super) fn install_checkouts(&mut self, response: serde_json::Value) {
        self.apply_checkouts(Ok(response));
    }
}
