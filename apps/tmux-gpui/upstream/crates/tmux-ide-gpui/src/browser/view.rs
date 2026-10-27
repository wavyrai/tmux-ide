//! The window side of browser tabs: their entries in the tab strip, the page
//! and its toolbar in a group where the terminal would be, and requests to
//! open one.
#[cfg(any(target_os = "macos", windows))]
use super::Annotations;
use super::{
    Location, Scope, Store, TabId, WebUrl,
    groups::{GroupId, GroupIds, Layout, Pick, SavedLayout},
};
use crate::{HerdrWindow, NavigationTarget, search_input::SearchInput, window::Flash};
use gpui::{prelude::*, *};
#[cfg(any(target_os = "macos", windows))]
use present::Freeze;
use std::collections::{HashMap, HashSet};

mod present;
mod render;
#[cfg(unix)]
mod requests;

/// One window's browser state. How each workspace's view is split, and what
/// each group shows, is the window's own choice, like its focused workspace;
/// the tabs themselves are the app's.
pub(crate) struct Browser {
    /// Per workspace, its groups. A workspace missing here has one group
    /// following its terminal.
    pub(crate) layouts: HashMap<(Scope, String), Layout>,
    /// Layouts saved before this window opened, restored the first time it
    /// shows each workspace.
    pub(crate) saved: HashMap<(Scope, String), SavedLayout>,
    /// The workspace whose layout was just restored, whose group in use is
    /// taken back to its tab once, rather than following wherever the
    /// daemon's focus was left.
    pub(crate) restored: Option<(Scope, String)>,
    pub(super) group_ids: GroupIds,
    /// The group drawn before the window has a workspace to split.
    pub(super) fallback_group: GroupId,
    #[cfg(any(target_os = "macos", windows))]
    pub(super) pages: super::Pages,
    /// Where each page drew last frame, to tell which ones a menu covers.
    #[cfg(any(target_os = "macos", windows))]
    page_bounds: std::rc::Rc<std::cell::RefCell<HashMap<TabId, Bounds<Pixels>>>>,
    /// Pages a menu covers, stood in for by a picture of themselves.
    #[cfg(any(target_os = "macos", windows))]
    frozen: HashMap<TabId, Freeze>,
    /// Each group's address field, and the tab whose address it last showed.
    pub(super) addresses: HashMap<GroupId, (Entity<SearchInput>, Option<TabId>)>,
    /// The group whose "+" asked for a new Herdr tab, which it picks once
    /// the daemon focuses the tab.
    pub(super) new_tab_group: Option<((Scope, String), GroupId)>,
    /// The connection of each group that shows a terminal.
    pub(crate) terminals: crate::group_terminals::GroupTerminals,
    /// Tabs growing into the strip as they open.
    pub(super) appear: super::tab_appear::TabAppear,
    /// Each strip's sideways scroll.
    pub(super) tab_scroll: super::tab_scroll::TabScroll,
    /// Groups opening from a split and folding away as they close.
    pub(super) group_motion: super::group_motion::GroupMotion,
    /// Why a tab's page could not be created, shown in its place.
    pub(super) failed: Option<(TabId, SharedString)>,
    /// The workspaces of the last snapshot and the boot they came from: one
    /// missing from the next snapshot of the same boot was closed.
    workspaces: Option<(Scope, String, HashSet<String>)>,
    #[cfg(any(target_os = "macos", windows))]
    pub(super) annotations: Annotations,
}

impl Browser {
    pub(crate) fn new(cx: &mut App) -> Self {
        let mut group_ids = GroupIds::default();
        Self {
            layouts: HashMap::new(),
            saved: super::Layouts::snapshot(cx),
            restored: None,
            fallback_group: group_ids.next(),
            group_ids,
            #[cfg(any(target_os = "macos", windows))]
            pages: Default::default(),
            #[cfg(any(target_os = "macos", windows))]
            page_bounds: Default::default(),
            #[cfg(any(target_os = "macos", windows))]
            frozen: HashMap::new(),
            addresses: HashMap::new(),
            new_tab_group: None,
            terminals: Default::default(),
            appear: Default::default(),
            tab_scroll: Default::default(),
            group_motion: Default::default(),
            failed: None,
            workspaces: None,
            #[cfg(any(target_os = "macos", windows))]
            annotations: Annotations::new(cx),
        }
    }
}

/// Names the daemon behind an endpoint the way browser tabs remember it.
pub(crate) fn scope(endpoint: &crate::endpoint::Endpoint) -> Scope {
    match endpoint.connection.target.socket_path() {
        Ok(path) => Scope::local(&path),
        Err(_) => Scope::endpoint(&endpoint.id),
    }
}

/// Page titles run long; a tab shows the start of one, like a web browser.
pub(super) fn tab_label(title: &str) -> SharedString {
    const MAX_CHARS: usize = 28;
    match title.char_indices().nth(MAX_CHARS) {
        Some((end, _)) => format!("{}\u{2026}", title[..end].trim_end()).into(),
        None => title.to_owned().into(),
    }
}

pub(super) fn store(cx: &App) -> Option<&Store> {
    cx.try_global::<Store>()
}

impl HerdrWindow {
    pub(crate) fn browser_key(&self) -> Option<(Scope, String)> {
        let workspace = self.live.snapshot.as_ref()?.focused_workspace_id.clone()?;
        Some((scope(&self.endpoints[self.selected_endpoint]), workspace))
    }

    /// The focused workspace's browser tabs, in the order they opened.
    pub(crate) fn browser_tab_ids(&self, cx: &App) -> Vec<TabId> {
        let (Some((scope, workspace)), Some(store)) = (self.browser_key(), store(cx)) else {
            return Vec::new();
        };
        store
            .in_workspace(&scope, &workspace)
            .map(|tab| tab.id)
            .collect()
    }

    pub(super) fn forget_browser_tabs(&mut self, mut gone: impl FnMut(TabId) -> bool) {
        #[cfg(any(target_os = "macos", windows))]
        {
            self.browser.frozen.retain(|id, _| !gone(*id));
            self.browser
                .page_bounds
                .borrow_mut()
                .retain(|id, _| !gone(*id));
        }
        let key = self.browser_key();
        let focused = self.focused_herdr_tab().map(str::to_owned);
        for (workspace, layout) in &mut self.browser.layouts {
            // Only the focused workspace's terminal is known here.
            let focused = focused
                .as_deref()
                .filter(|_| key.as_ref() == Some(workspace));
            let closed: Vec<Pick> = layout
                .picks()
                .filter(|pick| matches!(pick, Pick::Page(id) if gone(*id)))
                .cloned()
                .collect();
            for pick in closed {
                layout.replace(&pick, None, focused);
            }
        }
        #[cfg(any(target_os = "macos", windows))]
        self.browser.pages.retain(|id| !gone(id));
        if self
            .browser
            .failed
            .as_ref()
            .is_some_and(|(id, _)| gone(*id))
        {
            self.browser.failed = None;
        }
        #[cfg(any(target_os = "macos", windows))]
        let annotated: Vec<TabId> = self
            .browser
            .annotations
            .ids()
            .filter(|id| gone(*id))
            .collect();
        #[cfg(any(target_os = "macos", windows))]
        for id in annotated {
            self.browser.annotations.forget(id);
        }
    }

    /// Opens a tab in the focused workspace, or tells the user why not.
    pub(crate) fn open_browser_tab(
        &mut self,
        url: Option<WebUrl>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !super::EMBEDDED {
            match url {
                Some(url) => cx.open_url(url.as_str()),
                None => self.show_flash(Flash::warning("Browser tabs need macOS or Windows"), cx),
            }
            return;
        }
        let Some((scope, workspace)) = self.browser_key() else {
            self.show_flash(Flash::warning("Open a workspace first"), cx);
            return;
        };
        let location = url.map(|url| Location::Web { url });
        match Store::update(cx, |store| store.open(scope, &workspace, location, None)) {
            Some(id) => self.show_browser_tab(id, window, cx),
            None => self.show_flash(Flash::warning("Too many browser tabs are open"), cx),
        }
    }

    /// Opens `url` in a tab of one endpoint's workspace and shows it there,
    /// as clicking a listening port does. The page's tab is reused when the
    /// workspace already has one on that address. Builds that cannot embed a
    /// page hand it to the system browser.
    pub(crate) fn open_workspace_page(
        &mut self,
        endpoint: &str,
        workspace: &str,
        url: WebUrl,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !super::EMBEDDED {
            cx.open_url(url.as_str());
            return;
        }
        let Some(index) = self.endpoints.iter().position(|e| e.id == endpoint) else {
            return;
        };
        let scope = scope(&self.endpoints[index]);
        let location = Location::Web { url };
        let before =
            store(cx).and_then(|store| store.opened_before(&scope, workspace, None, &location));
        let opened = before.or_else(|| {
            Store::update(cx, |store| {
                store.open(scope, workspace, Some(location), None)
            })
        });
        let Some(id) = opened else {
            self.show_flash(Flash::warning("Too many browser tabs are open"), cx);
            return;
        };
        if !self.navigate_endpoint(endpoint, NavigationTarget::Workspace(workspace), cx) {
            return;
        }
        // Recorded against the workspace, so the tab shows once the
        // navigation lands even if it is still in flight.
        self.show_browser_tab(id, window, cx);
        cx.notify();
    }

    /// Applies page reports, drops tabs other windows closed, and forgets the
    /// tabs of workspaces the daemon closed. Runs on every window tick.
    pub(crate) fn poll_browser(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        #[cfg(any(target_os = "macos", windows))]
        self.apply_page_events(window, cx);
        if let Some(store) = store(cx) {
            let gone: HashSet<TabId> = self
                .browser
                .layouts
                .values()
                .flat_map(Layout::picks)
                .filter_map(|pick| match pick {
                    Pick::Page(id) => Some(*id),
                    Pick::Herdr(_) => None,
                })
                .filter(|id| store.get(*id).is_none())
                .collect();
            #[cfg(any(target_os = "macos", windows))]
            let gone: HashSet<TabId> = gone
                .into_iter()
                .chain(
                    self.browser
                        .pages
                        .ids()
                        .filter(|id| store.get(*id).is_none()),
                )
                .collect();
            if !gone.is_empty() {
                self.forget_browser_tabs(|id| gone.contains(&id));
                cx.notify();
            }
        }
        self.forget_closed_workspaces(cx);
        self.forget_closed_herdr_tabs(cx);
        self.poll_deliveries(cx);
        self.poll_reviews(cx);
        self.sync_addresses(false, window, cx);
    }

    fn forget_closed_workspaces(&mut self, cx: &mut Context<Self>) {
        let Some(snapshot) = self.live.snapshot.as_ref() else {
            return;
        };
        let scope = scope(&self.endpoints[self.selected_endpoint]);
        let unchanged = self
            .browser
            .workspaces
            .as_ref()
            .is_some_and(|(seen_scope, boot, seen)| {
                seen_scope == &scope
                    && boot == &snapshot.boot_id
                    && seen.len() == snapshot.workspaces.len()
                    && snapshot
                        .workspaces
                        .iter()
                        .all(|workspace| seen.contains(&workspace.workspace_id))
            });
        if unchanged {
            return;
        }
        let current: HashSet<String> = snapshot
            .workspaces
            .iter()
            .map(|workspace| workspace.workspace_id.clone())
            .collect();
        let previous = self.browser.workspaces.replace((
            scope.clone(),
            snapshot.boot_id.clone(),
            current.clone(),
        ));
        // A restarted daemon or another session proves nothing was closed.
        let Some((_, _, seen)) = previous
            .filter(|(seen_scope, boot, _)| seen_scope == &scope && boot == &snapshot.boot_id)
        else {
            return;
        };
        let closed: Vec<String> = seen.difference(&current).cloned().collect();
        if closed.is_empty() {
            return;
        }
        self.browser
            .layouts
            .retain(|(saved, workspace), _| saved != &scope || !closed.contains(workspace));
        super::Layouts::forget_workspaces(cx, &scope, &closed);
        if !store(cx).is_some_and(|store| store.has_workspaces(&scope, &closed)) {
            return;
        }
        Store::update(cx, |store| store.forget_workspaces(&scope, &closed));
        cx.notify();
    }

    #[cfg(any(target_os = "macos", windows))]
    fn apply_page_events(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use super::native::Event;
        while let Some(event) = self.browser.pages.next_event() {
            match event {
                Event::Title(id, title) => {
                    Store::update(cx, |store| store.visited(id, None, Some(&title)));
                }
                // The field follows on the next sync, unless someone is
                // typing in it.
                Event::Loaded(id, url) => {
                    let visited = store(cx)
                        .and_then(|store| store.get(id))
                        .and_then(|tab| tab.location.as_ref()?.visited(&url));
                    if let Some(location) = visited {
                        Store::update(cx, |store| store.visited(id, Some(location), None));
                    }
                    self.page_loaded(id, cx);
                }
                Event::Posted(id, body) => self.page_posted(id, &body, window, cx),
                #[cfg(target_os = "macos")]
                Event::Captured(id, capture, tiff) => self.page_captured(id, capture, tiff, cx),
                #[cfg(target_os = "macos")]
                Event::Frozen(id, tiff) => self.page_frozen(id, tiff, cx),
                Event::NewWindow(id, url) => {
                    if let Ok(url) = WebUrl::try_from(url.as_str())
                        && let Some(opened) = self.open_beside(id, url, cx)
                    {
                        self.show_browser_tab_in(opened.0, opened.1, window, cx);
                    }
                }
                #[cfg(target_os = "macos")]
                Event::Opened(id, url, source, popup) => {
                    // Without a tab the popup is dropped, and with it the
                    // opener's link to it.
                    if let Some((group, opened)) = self.open_beside(id, url, cx) {
                        self.browser.pages.adopt(opened, source, popup, window, cx);
                        self.show_browser_tab_in(group, opened, window, cx);
                    }
                }
                #[cfg(target_os = "macos")]
                Event::Closed(id) => self.close_browser_tab(id, window, cx),
            }
        }
    }

    /// Opens a tab on `url` for a page of tab `opener`, in its workspace and
    /// in the group showing it. Returns that group and the new tab.
    #[cfg(any(target_os = "macos", windows))]
    fn open_beside(
        &mut self,
        opener: TabId,
        url: WebUrl,
        cx: &mut Context<Self>,
    ) -> Option<(Option<GroupId>, TabId)> {
        let parent = store(cx).and_then(|store| store.get(opener)).cloned()?;
        let group = self.group_showing(&Pick::Page(opener), cx);
        let opened = Store::update(cx, |store| {
            store.open(
                parent.scope,
                &parent.workspace_id,
                Some(Location::Web { url }),
                parent.origin,
            )
        })?;
        Some((group, opened))
    }

    /// Whether a notes panel or a note is still moving, so the window draws
    /// another frame. Only builds that show pages have either.
    pub(crate) fn annotations_moving(&self) -> bool {
        #[cfg(any(target_os = "macos", windows))]
        return self.browser.annotations.moving(std::time::Instant::now());
        #[cfg(not(any(target_os = "macos", windows)))]
        false
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn long_titles_are_shortened_on_a_character_boundary() {
        assert_eq!(super::tab_label("Example Domain"), "Example Domain");
        let long = "Rust Programming Language — Official Site";
        assert_eq!(
            super::tab_label(long),
            "Rust Programming Language \u{2014}\u{2026}"
        );
        assert_eq!(super::tab_label(&"é".repeat(40)).chars().count(), 29);
    }
}
