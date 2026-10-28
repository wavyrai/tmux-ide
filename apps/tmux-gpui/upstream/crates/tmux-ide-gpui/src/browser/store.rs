//! The app's browser tabs: which page each one shows and the workspace it
//! belongs to. Herdr has no browser panes, so these live only in this client;
//! every window shows the same tabs for a workspace, each with its own page.
use super::Location;
use crate::{reorder::Beside, state_file};
use gpui::{App, Global};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const MAX_TABS: usize = 256;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TITLE_CHARS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct TabId(u64);

#[cfg(test)]
impl TabId {
    pub(crate) fn test(id: u64) -> Self {
        Self(id)
    }
}

impl std::fmt::Display for TabId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// The daemon a workspace ID belongs to. IDs are only unique within one
/// daemon, so a local session and a saved host can both have a `w_1`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct Scope(String);

impl Scope {
    /// A local daemon, named by the client socket the window connects to.
    pub(crate) fn local(client_socket: &std::path::Path) -> Self {
        Self(format!("local:{}", client_socket.display()))
    }

    /// A saved SSH host, named by its catalog ID.
    pub(crate) fn endpoint(id: &str) -> Self {
        Self(id.to_owned())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Tab {
    pub id: TabId,
    pub scope: Scope,
    pub workspace_id: String,
    /// `None` for a new tab still waiting for an address.
    pub location: Option<Location>,
    /// The page's own title once it reports one; the host until then.
    pub title: String,
    /// The Herdr pane whose agent opened the tab, which notes on the page
    /// go back to.
    #[serde(default)]
    pub origin: Option<String>,
}

impl Tab {
    fn valid(&self) -> bool {
        !self.workspace_id.is_empty()
            && self.workspace_id.len() <= 256
            && self.title.chars().count() <= MAX_TITLE_CHARS
            && self
                .origin
                .as_ref()
                .is_none_or(|pane| !pane.is_empty() && pane.len() <= 256)
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    tabs: Vec<Tab>,
}

#[derive(Default)]
pub(crate) struct Store {
    tabs: Vec<Tab>,
    next: u64,
    writer: Option<state_file::Writer<Saved>>,
    quitting: bool,
}

impl Global for Store {}

/// Page titles are untrusted: one line, bounded, and free of control and
/// bidirectional formatting characters that could disguise a tab.
fn clean_title(title: &str) -> String {
    crate::notifications::safe_text(title, MAX_TITLE_CHARS * 4)
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn parse(bytes: &[u8]) -> crate::Result<Vec<Tab>> {
    let saved: Saved = serde_json::from_slice(bytes)?;
    if saved.tabs.len() > MAX_TABS || !saved.tabs.iter().all(Tab::valid) {
        return Err(crate::Error::InvalidBrowserTabs);
    }
    Ok(saved.tabs)
}

impl Store {
    fn path() -> Option<PathBuf> {
        crate::preferences::state_dir().map(|dir| dir.join("browser-tabs.json"))
    }

    /// Called before starting GPUI, like the window state. A missing or
    /// damaged file starts with no tabs.
    pub(crate) fn load() -> Self {
        let path = Self::path();
        let tabs = path
            .as_deref()
            .map(|path| {
                state_file::read(path, MAX_FILE_BYTES)
                    .and_then(|bytes| bytes.as_deref().map_or(Ok(Vec::new()), parse))
            })
            .transpose()
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "Cannot restore browser tabs");
                None
            })
            .unwrap_or_default();
        let writer = path.and_then(
            |path| match state_file::Writer::start("browser-tabs", path) {
                Ok(writer) => Some(writer),
                Err(error) => {
                    tracing::warn!(%error, "Cannot start browser-tab worker");
                    None
                }
            },
        );
        Self::with_tabs(tabs, writer)
    }

    fn with_tabs(tabs: Vec<Tab>, writer: Option<state_file::Writer<Saved>>) -> Self {
        let next = tabs.iter().map(|tab| tab.id.0 + 1).max().unwrap_or(0);
        Self {
            tabs,
            next,
            writer,
            quitting: false,
        }
    }

    pub(crate) fn install(self, cx: &mut App) {
        cx.set_global(self);
        cx.on_app_quit(|cx| {
            let store = cx.global_mut::<Self>();
            store.quitting = true;
            let writer = store.writer.take();
            cx.background_executor().spawn(async move {
                if let Some(writer) = writer {
                    writer.finish();
                }
            })
        })
        .detach();
    }

    /// Runs `f` against the app's store, creating an unsaved one for
    /// fixtures that never installed it.
    pub(crate) fn update<R>(cx: &mut App, f: impl FnOnce(&mut Self) -> R) -> R {
        if !cx.has_global::<Self>() {
            cx.set_global(Self::default());
        }
        f(cx.global_mut::<Self>())
    }

    fn save(&self) {
        if self.quitting {
            return;
        }
        if let Some(writer) = &self.writer {
            writer.save(Saved {
                tabs: self.tabs.clone(),
            });
        }
    }

    pub(crate) fn get(&self, id: TabId) -> Option<&Tab> {
        self.tabs.iter().find(|tab| tab.id == id)
    }

    /// The tabs of one workspace, in the order they were opened.
    pub(crate) fn in_workspace<'a>(
        &'a self,
        scope: &'a Scope,
        workspace_id: &'a str,
    ) -> impl Iterator<Item = &'a Tab> + 'a {
        self.tabs
            .iter()
            .filter(move |tab| &tab.scope == scope && tab.workspace_id == workspace_id)
    }

    /// Opens a tab, or returns `None` when the app already holds the most
    /// it keeps.
    pub(crate) fn open(
        &mut self,
        scope: Scope,
        workspace_id: &str,
        location: Option<Location>,
        origin: Option<String>,
    ) -> Option<TabId> {
        if self.tabs.len() >= MAX_TABS {
            return None;
        }
        let id = TabId(self.next);
        self.next += 1;
        self.tabs.push(Tab {
            id,
            scope,
            workspace_id: workspace_id.to_owned(),
            title: location
                .as_ref()
                .map_or_else(|| "New Tab".to_owned(), Location::default_title),
            location,
            origin,
        });
        self.save();
        Some(id)
    }

    /// The tab one agent, or the user when `origin` is None, already opened
    /// on this page, which showing the page again reuses rather than stacking
    /// another tab.
    pub(crate) fn opened_before(
        &self,
        scope: &Scope,
        workspace_id: &str,
        origin: Option<&str>,
        location: &Location,
    ) -> Option<TabId> {
        self.tabs
            .iter()
            .find(|tab| {
                &tab.scope == scope
                    && tab.workspace_id == workspace_id
                    && tab.origin.as_deref() == origin
                    && tab.location.as_ref() == Some(location)
            })
            .map(|tab| tab.id)
    }

    /// The tabs a pane's agent opened.
    #[cfg(any(unix, test))]
    pub(crate) fn opened_by<'a>(&'a self, pane_id: &'a str) -> impl Iterator<Item = &'a Tab> + 'a {
        self.tabs
            .iter()
            .filter(move |tab| tab.origin.as_deref() == Some(pane_id))
    }

    /// Moves a tab beside another; whether it moved. Workspaces list their
    /// tabs in store order, so landing beside one of the same workspace
    /// reorders that workspace's strip alone.
    pub(crate) fn move_tab(&mut self, id: TabId, beside: Beside<TabId>) -> bool {
        let (Beside::Before(anchor) | Beside::After(anchor)) = beside;
        if anchor == id {
            return false;
        }
        let Some(from) = self.tabs.iter().position(|tab| tab.id == id) else {
            return false;
        };
        let tab = self.tabs.remove(from);
        let Some(at) = self.tabs.iter().position(|tab| tab.id == anchor) else {
            self.tabs.insert(from, tab);
            return false;
        };
        let to = match beside {
            Beside::Before(_) => at,
            Beside::After(_) => at + 1,
        };
        self.tabs.insert(to, tab);
        if to == from {
            return false;
        }
        self.save();
        true
    }

    pub(crate) fn close(&mut self, id: TabId) -> Option<Tab> {
        let index = self.tabs.iter().position(|tab| tab.id == id)?;
        let tab = self.tabs.remove(index);
        self.save();
        Some(tab)
    }

    /// Records where a page went and what it calls itself. Returns whether
    /// anything changed.
    pub(crate) fn visited(
        &mut self,
        id: TabId,
        location: Option<Location>,
        title: Option<&str>,
    ) -> bool {
        let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == id) else {
            return false;
        };
        let mut changed = false;
        if let Some(location) = location
            && tab.location.as_ref() != Some(&location)
        {
            tab.location = Some(location);
            changed = true;
        }
        if let Some(title) = title.map(clean_title).filter(|title| !title.is_empty())
            && tab.title != title
        {
            tab.title = title;
            changed = true;
        }
        if changed {
            self.save();
        }
        changed
    }

    /// Drops the tabs of workspaces the daemon closed.
    pub(crate) fn forget_workspaces(&mut self, scope: &Scope, closed: &[String]) -> bool {
        let before = self.tabs.len();
        self.tabs
            .retain(|tab| &tab.scope != scope || !closed.contains(&tab.workspace_id));
        let changed = self.tabs.len() != before;
        if changed {
            self.save();
        }
        changed
    }

    /// Whether any tab belongs to one of `closed`, without claiming the
    /// store for writing, which would redraw every window.
    pub(crate) fn has_workspaces(&self, scope: &Scope, closed: &[String]) -> bool {
        self.tabs
            .iter()
            .any(|tab| &tab.scope == scope && closed.contains(&tab.workspace_id))
    }
}

#[cfg(test)]
mod tests;
