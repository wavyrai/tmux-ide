use crate::{
    Error, HerdrWindow, NavigationTarget, OwnedNavigationTarget, Result,
    controls::{COMMANDS, Command},
    keymap::Reach,
    menu::Page,
    search_input::{Changed, SearchInput},
};
use gpui::{prelude::*, *};
use herdr_client::{
    Method,
    protocol::{ClientShellCommandAction, ClientShellSnapshot},
};
use serde_json::{Value, json};
use std::sync::Arc;

mod go_to;
#[cfg(test)]
mod interaction_tests;
mod project_open;
mod projects;
mod render;
mod search;

use go_to::{destination_exists, go_to_entries, note_entries};

#[derive(Clone, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct PaletteConfig {
    pub double_shift: bool,
    pub project_roots: Vec<String>,
}

impl Default for PaletteConfig {
    fn default() -> Self {
        Self {
            double_shift: true,
            project_roots: Vec::new(),
        }
    }
}

impl PaletteConfig {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.project_roots.len() > 16
            || self.project_roots.iter().any(|root| {
                root.trim().is_empty() || root.len() > 8192 || root.chars().any(char::is_control)
            })
        {
            return Err(Error::PaletteProjectRoots);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Filter {
    #[default]
    All,
    Navigation,
    Commands,
    Projects,
    /// Checkouts the user keeps a note on.
    Notes,
}

impl Filter {
    const ALL: [Self; 5] = [
        Self::All,
        Self::Navigation,
        Self::Commands,
        Self::Projects,
        Self::Notes,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Navigation => "Navigation",
            Self::Commands => "Commands",
            Self::Projects => "Projects",
            Self::Notes => "Notes",
        }
    }

    fn accepts(self, action: &Action) -> bool {
        self == Self::All
            || self
                == match action {
                    Action::Native(_) | Action::Configured(..) => Self::Commands,
                    Action::Go { .. } => Self::Navigation,
                    Action::Project(_) => Self::Projects,
                    Action::Note { .. } => Self::Notes,
                }
    }
}

#[derive(Clone)]
enum Action {
    Native(Command),
    /// A Go To destination, qualified by the host and daemon boot it was listed from.
    Go {
        endpoint: String,
        boot: String,
        target: OwnedNavigationTarget,
    },
    Configured(String, ClientShellCommandAction),
    Project(projects::Project),
    /// A workspace whose checkout has a note, gone to as Go To goes to it.
    Note {
        endpoint: String,
        boot: String,
        workspace: String,
    },
}

struct Entry {
    label: SharedString,
    detail: SharedString,
    badge: SharedString,
    action: Action,
    /// Index of the earlier row this one nests under, indented only while
    /// that row is visible so a search never leaves it hanging beneath nothing.
    parent: Option<usize>,
    fields: search::Fields,
}

impl Entry {
    fn new(
        label: String,
        detail: String,
        badge: impl Into<SharedString>,
        action: Action,
        parent: Option<usize>,
    ) -> Self {
        Self::with_keywords(label, detail, badge, action, parent, "")
    }

    /// `keywords` are searchable but never shown, such as an agent's kind.
    fn with_keywords(
        label: String,
        detail: String,
        badge: impl Into<SharedString>,
        action: Action,
        parent: Option<usize>,
        keywords: &str,
    ) -> Self {
        let badge = badge.into();
        let id = match &action {
            Action::Configured(id, _) => id.as_str(),
            _ => "",
        };
        // The detail leads the context so match indices map back onto it.
        let fields = search::Fields::new(&label, &format!("{detail} {badge} {id} {keywords}"));
        Self {
            label: label.into(),
            detail: detail.into(),
            badge,
            action,
            parent,
            fields,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Identity {
    Native(Command),
    Go(String, OwnedNavigationTarget),
    Configured(String),
    Project(std::path::PathBuf),
    Note(String, String),
}

impl Action {
    fn identity(&self) -> Identity {
        match self {
            Self::Native(command) => Identity::Native(*command),
            Self::Go {
                endpoint, target, ..
            } => Identity::Go(endpoint.clone(), target.clone()),
            Self::Configured(id, _) => Identity::Configured(id.clone()),
            Self::Project(project) => Identity::Project(project.path.clone()),
            Self::Note {
                endpoint,
                workspace,
                ..
            } => Identity::Note(endpoint.clone(), workspace.clone()),
        }
    }
}

#[derive(Clone)]
struct Target {
    boot: String,
    workspace: Option<String>,
    tab: Option<String>,
    pane: Option<String>,
}

impl Target {
    fn capture(snapshot: &ClientShellSnapshot) -> Self {
        Self {
            boot: snapshot.boot_id.clone(),
            workspace: snapshot.focused_workspace_id.clone(),
            tab: snapshot.focused_tab_id.clone(),
            pane: snapshot.focused_pane_id.clone(),
        }
    }

    fn validate_boot(&self, snapshot: &ClientShellSnapshot) -> Result<()> {
        if self.boot.is_empty() || self.boot != snapshot.boot_id {
            return Err(Error::PaletteSessionChanged);
        }
        Ok(())
    }

    fn workspace_exists(&self, snapshot: &ClientShellSnapshot, id: &str) -> Result<()> {
        self.validate_boot(snapshot)?;
        if !snapshot.workspaces.iter().any(|w| w.workspace_id == id) {
            return Err(Error::PaletteWorkspaceRemoved);
        }
        Ok(())
    }

    fn invocation(
        &self,
        snapshot: &ClientShellSnapshot,
        id: &str,
        action: ClientShellCommandAction,
    ) -> Result<Value> {
        self.validate_boot(snapshot)?;
        if action == ClientShellCommandAction::Unknown {
            return Err(Error::UnsupportedCommand);
        }
        if !snapshot
            .commands
            .iter()
            .any(|c| c.command_id == id && c.action == action)
        {
            return Err(Error::PaletteCommandChanged);
        }
        if let Some(id) = &self.workspace {
            self.workspace_exists(snapshot, id)?;
        }
        if let Some(id) = &self.tab
            && !snapshot
                .tabs
                .iter()
                .any(|t| t.tab_id == *id && self.workspace.as_ref() == Some(&t.workspace_id))
        {
            return Err(Error::PaletteTabRemoved);
        }
        if let Some(id) = &self.pane
            && !snapshot.panes.iter().any(|p| {
                p.pane_id == *id
                    && self.workspace.as_ref() == Some(&p.workspace_id)
                    && self.tab.as_ref() == Some(&p.tab_id)
            })
        {
            return Err(Error::PalettePaneRemoved);
        }
        let mut params = json!({"command_id": id});
        for (key, value) in [
            ("workspace_id", &self.workspace),
            ("tab_id", &self.tab),
            ("pane_id", &self.pane),
        ] {
            if let Some(value) = value {
                params[key] = json!(value);
            }
        }
        Ok(params)
    }
}

/// Whether ranking may keep the previously shown selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Selection {
    First,
    Keep,
}

pub(super) struct Palette {
    pub search: Entity<SearchInput>,
    /// The entries `filtered` indexes. A ranking still running on the
    /// background executor keeps these on screen until it replaces both.
    entries: Arc<[Entry]>,
    filtered: Vec<search::Hit>,
    /// The newest entries, ranked by the next query.
    pending: Arc<[Entry]>,
    matcher: nucleo_matcher::Matcher,
    match_task: Option<Task<()>>,
    selected: usize,
    scroll: UniformListScrollHandle,
    target: Option<Target>,
    filter: Filter,
    query: String,
    error: Option<String>,
    projects: projects::Collection,
    loading_projects: bool,
    project_task: Option<Task<()>>,
    _scan: projects::Cancellation,
    sources: Vec<Source>,
    local_target: Option<LocalTarget>,
    project_operation: ProjectOperation,
    configuration: PaletteConfig,
    keymap: crate::keymap::Keymap,
    supports_clear: bool,
    supports_edit_scrollback: bool,
    /// The notes revision the entries were prepared from.
    notes_revision: Option<u64>,
    _subscription: Subscription,
}

/// Metadata snapshots, not surface updates, invalidate the prepared entries.
struct Source {
    endpoint: String,
    generation: u64,
    enabled: bool,
    snapshot: Option<Arc<ClientShellSnapshot>>,
}

#[derive(Clone)]
struct LocalTarget {
    generation: u64,
    boot: String,
}

#[derive(Default)]
enum ProjectOperation {
    #[default]
    Idle,
    Validating {
        _task: Task<()>,
    },
    Awaiting(String),
}

impl Palette {
    fn selected_identity(&self) -> Option<Identity> {
        self.filtered
            .get(self.selected)
            .map(|hit| self.entries[hit.index].action.identity())
    }

    fn selected_entry(&self) -> Option<&Entry> {
        self.filtered
            .get(self.selected)
            .map(|hit| &self.entries[hit.index])
    }

    /// Shows `filtered` rows of `entries`, keeping the selected destination
    /// when asked and it is still listed.
    fn apply(&mut self, entries: Arc<[Entry]>, filtered: Vec<search::Hit>, selection: Selection) {
        let selected = match selection {
            Selection::Keep => self.selected_identity(),
            Selection::First => None,
        };
        self.entries = entries;
        self.filtered = filtered;
        self.selected = selected
            .and_then(|selected| {
                self.filtered
                    .iter()
                    .position(|hit| self.entries[hit.index].action.identity() == selected)
            })
            .unwrap_or(0);
        self.scroll
            .scroll_to_item(self.selected, ScrollStrategy::Nearest);
    }

    fn busy(&self) -> bool {
        !matches!(self.project_operation, ProjectOperation::Idle)
    }
}

impl HerdrWindow {
    pub(super) fn filter_palette(&mut self, query: &str, cx: &mut Context<Self>) {
        if let Some(palette) = &mut self.menu.palette {
            palette.query = query.to_owned();
        }
        self.rank_palette(Selection::First, cx);
    }

    pub(super) fn set_palette_filter(&mut self, filter: Filter, cx: &mut Context<Self>) {
        if let Some(palette) = &mut self.menu.palette {
            palette.filter = filter;
        }
        self.rank_palette(Selection::First, cx);
    }

    /// Ranks the newest entries against the query. Short lists are ranked
    /// inline; longer ones on the background executor, so typing never waits
    /// on them. A newer ranking drops an unfinished one with its task.
    fn rank_palette(&mut self, selection: Selection, cx: &mut Context<Self>) {
        let Some(palette) = &mut self.menu.palette else {
            return;
        };
        let entries = palette.pending.clone();
        let filter = palette.filter;
        let candidates: Vec<_> = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| filter.accepts(&entry.action))
            .map(|(index, _)| index)
            .collect();
        let query = search::Query::parse(&palette.query);
        if candidates.len() <= search::INLINE_CANDIDATES {
            palette.match_task = None;
            let filtered = search::rank(&entries, candidates, &query, &mut palette.matcher);
            palette.apply(entries, filtered, selection);
            cx.notify();
            return;
        }
        let ranking = cx.background_spawn({
            let entries = entries.clone();
            async move { search::rank(&entries, candidates, &query, &mut search::matcher()) }
        });
        let token = palette.search.clone();
        palette.match_task = Some(cx.spawn(async move |this, cx| {
            let filtered = ranking.await;
            let _ = this.update(cx, |this, cx| {
                let Some(palette) = &mut this.menu.palette else {
                    return;
                };
                if palette.search != token || !Arc::ptr_eq(&palette.pending, &entries) {
                    return;
                }
                palette.match_task = None;
                palette.apply(entries, filtered, selection);
                cx.notify();
            });
        }));
    }

    pub(super) fn open_palette(
        &mut self,
        filter: Filter,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.open_menu(window, cx) {
            return;
        }
        self.menu.page = Some(Page::Palette);
        let search = cx.new(SearchInput::new);
        let subscription = cx.subscribe(&search, |this, search, _: &Changed, cx| {
            let query = search.read(cx).text().to_owned();
            this.filter_palette(&query, cx);
        });
        let target = self
            .live
            .snapshot
            .as_ref()
            .map(|snapshot| Target::capture(snapshot));
        let local_target = self
            .endpoints
            .iter()
            .position(|endpoint| endpoint.id == crate::endpoint::LOCAL)
            .and_then(|index| {
                let live = if index == self.selected_endpoint {
                    &self.live
                } else {
                    &self.endpoints[index].live
                };
                live.snapshot.as_ref().map(|snapshot| LocalTarget {
                    generation: self.endpoints[index].generation,
                    boot: snapshot.boot_id.clone(),
                })
            });
        search.update(cx, |input, cx| {
            input.set_placeholder("Search workspaces, commands, agents, and projects...", cx);
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
            window.focus(&input.focus, cx);
        });
        let mut palette = Palette {
            search,
            entries: Arc::new([]),
            filtered: Vec::new(),
            pending: Arc::new([]),
            matcher: search::matcher(),
            match_task: None,
            selected: 0,
            scroll: UniformListScrollHandle::new(),
            target,
            filter,
            query: String::new(),
            error: None,
            projects: projects::Collection::default(),
            loading_projects: !self.config.palette.project_roots.is_empty(),
            project_task: None,
            _scan: projects::Cancellation::default(),
            sources: Vec::new(),
            local_target,
            project_operation: ProjectOperation::Idle,
            configuration: self.config.palette.clone(),
            keymap: self.keymap().clone(),
            supports_clear: self.live.supports_pane_clear,
            supports_edit_scrollback: self.live.supports_edit_scrollback,
            notes_revision: None,
            _subscription: subscription,
        };
        self.prepare_palette_entries(&mut palette, crate::worktree_notes::Notes::of(cx));
        self.menu.palette = Some(palette);
        self.rank_palette(Selection::Keep, cx);
        self.load_palette_projects(window, cx);
        cx.notify();
    }

    fn palette_sources(&self) -> Vec<Source> {
        std::iter::once(self.selected_endpoint)
            .chain((0..self.endpoints.len()).filter(|index| *index != self.selected_endpoint))
            .map(|index| {
                let endpoint = &self.endpoints[index];
                let live = if index == self.selected_endpoint {
                    &self.live
                } else {
                    &endpoint.live
                };
                Source {
                    endpoint: endpoint.id.clone(),
                    generation: endpoint.generation,
                    enabled: endpoint.enabled && live.status.is_connected(),
                    snapshot: live.snapshot.clone(),
                }
            })
            .collect()
    }

    /// Rebuilds the entries; the caller ranks them once the palette is back
    /// in the menu.
    fn prepare_palette_entries(
        &self,
        palette: &mut Palette,
        notes: Option<&crate::worktree_notes::Notes>,
    ) {
        let mut entries = Vec::new();
        let sources = self.palette_sources();
        if let Some(notes) = notes {
            note_entries(notes, &sources, &self.endpoints, &mut entries);
        }
        for source in &sources {
            let Some(snapshot) = source.snapshot.as_ref().filter(|_| source.enabled) else {
                continue;
            };
            let host = self
                .endpoints
                .iter()
                .find(|endpoint| endpoint.id == source.endpoint)
                .map(|endpoint| endpoint.label.as_str());
            go_to_entries(&source.endpoint, host, snapshot, &mut entries);
        }
        entries.extend(
            COMMANDS
                .iter()
                .filter(|info| info.command != Command::Palette)
                .filter(|info| match info.command {
                    Command::ClearPane => self.live.supports_pane_clear,
                    Command::EditScrollback => self.live.supports_edit_scrollback,
                    _ => true,
                })
                .map(|info| {
                    Entry::new(
                        info.label.into(),
                        self.keymap().primary(info.command).into(),
                        "GUI action",
                        Action::Native(info.command),
                        None,
                    )
                }),
        );
        if let Some(snapshot) = self
            .live
            .snapshot
            .as_ref()
            .filter(|_| self.live.status.is_connected())
        {
            let bindings = self.keymap().custom_bindings(&snapshot.commands);
            entries.extend(
                snapshot
                    .commands
                    .iter()
                    .zip(bindings)
                    .map(|(command, bindings)| {
                        let bindings: Vec<_> = bindings
                            .into_iter()
                            .filter(|binding| binding.reach == Reach::Runs)
                            .map(|binding| binding.label)
                            .collect();
                        let host = &self.endpoints[self.selected_endpoint].label;
                        let workspace = palette
                            .target
                            .as_ref()
                            .and_then(|target| target.workspace.as_deref())
                            .and_then(|id| {
                                snapshot
                                    .workspaces
                                    .iter()
                                    .find(|workspace| workspace.workspace_id == id)
                            })
                            .map(|workspace| workspace.label.as_str());
                        let context = [Some(host.as_str()), workspace]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join("  ");
                        let detail = if bindings.is_empty() {
                            context
                        } else {
                            format!("{context}  {}", bindings.join(", "))
                        };
                        Entry::new(
                            command
                                .description
                                .as_ref()
                                .filter(|text| !text.trim().is_empty())
                                .unwrap_or(&command.command_id)
                                .clone(),
                            detail,
                            "Herdr command",
                            Action::Configured(command.command_id.clone(), command.action),
                            None,
                        )
                    }),
            );
        }
        entries.extend(palette.projects.projects.iter().map(|project| {
            Entry::new(
                project.label.clone(),
                format!("Local  {}", project.path.display()),
                "Project",
                Action::Project(project.clone()),
                None,
            )
        }));
        palette.pending = entries.into();
        palette.sources = sources;
        palette.keymap = self.keymap().clone();
        palette.supports_clear = self.live.supports_pane_clear;
        palette.supports_edit_scrollback = self.live.supports_edit_scrollback;
        palette.notes_revision = notes.map(crate::worktree_notes::Notes::revision);
    }

    pub(crate) fn refresh_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.update_palette_project(window, cx);
        let Some(palette) = self.menu.palette.as_ref() else {
            return;
        };
        if palette.configuration != self.config.palette {
            if let Some(mut palette) = self.menu.palette.take() {
                palette.project_task = None;
                if matches!(
                    palette.project_operation,
                    ProjectOperation::Validating { .. }
                ) {
                    palette.project_operation = ProjectOperation::Idle;
                }
                palette._scan = projects::Cancellation::default();
                palette.configuration = self.config.palette.clone();
                palette.projects = projects::Collection::default();
                palette.loading_projects = !self.config.palette.project_roots.is_empty();
                self.prepare_palette_entries(&mut palette, crate::worktree_notes::Notes::of(cx));
                self.menu.palette = Some(palette);
                self.rank_palette(Selection::Keep, cx);
                self.load_palette_projects(window, cx);
                cx.notify();
            }
            return;
        }
        let sources = self.palette_sources();
        let notes = crate::worktree_notes::Notes::of(cx);
        let changed = palette.notes_revision != notes.map(crate::worktree_notes::Notes::revision)
            || palette.keymap != *self.keymap()
            || palette.supports_clear != self.live.supports_pane_clear
            || palette.supports_edit_scrollback != self.live.supports_edit_scrollback
            || sources.len() != palette.sources.len()
            || sources.iter().zip(&palette.sources).any(|(a, b)| {
                a.endpoint != b.endpoint
                    || a.generation != b.generation
                    || a.enabled != b.enabled
                    || match (&a.snapshot, &b.snapshot) {
                        (Some(a), Some(b)) => !Arc::ptr_eq(a, b),
                        (None, None) => false,
                        _ => true,
                    }
            });
        if changed && let Some(mut palette) = self.menu.palette.take() {
            self.prepare_palette_entries(&mut palette, notes);
            self.menu.palette = Some(palette);
            self.rank_palette(Selection::Keep, cx);
        }
    }

    fn activate_palette(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        let action = match action {
            Action::Note {
                endpoint,
                boot,
                workspace,
            } => Action::Go {
                endpoint,
                boot,
                target: NavigationTarget::Workspace(workspace),
            },
            action => action,
        };
        if self.menu.palette.as_ref().is_none_or(Palette::busy) {
            return;
        }
        if !self.menu_target_current() {
            if let Some(palette) = &mut self.menu.palette {
                palette.error = Some("The selected connection changed. Reopen the palette.".into());
            }
            cx.notify();
            return;
        }
        if let Action::Native(command) = action {
            self.dismiss_menu(window, cx);
            self.command(command, window, cx);
            return;
        }
        if let Action::Project(project) = action {
            self.activate_project(project, window, cx);
            return;
        }
        if let Action::Go {
            endpoint,
            boot,
            target,
        } = &action
        {
            match self.go_to_ready(endpoint, boot, target.as_deref()) {
                Ok(selected) => {
                    self.dismiss_menu(window, cx);
                    if selected {
                        self.navigate(target.as_deref(), cx);
                    } else {
                        self.navigate_endpoint(endpoint, target.as_deref(), cx);
                    }
                }
                Err(error) => {
                    if let Some(palette) = &mut self.menu.palette {
                        palette.error = Some(error.to_string());
                    }
                    cx.notify();
                }
            }
            return;
        }
        let result = (|| {
            if !self.input_ready() {
                return Err(Error::PaletteConnectionNotReady);
            }
            let snapshot = self.live.snapshot.as_ref().ok_or(Error::NoSnapshot)?;
            let target = self
                .menu
                .palette
                .as_ref()
                .and_then(|p| p.target.as_ref())
                .ok_or(Error::NoPaletteSession)?;
            match &action {
                Action::Configured(id, action) => target.invocation(snapshot, id, *action),
                Action::Native(_)
                | Action::Go { .. }
                | Action::Project(_)
                | Action::Note { .. } => unreachable!(),
            }
        })();
        match result {
            Ok(params) => {
                self.request_focus_change(Method::CommandInvoke.as_str(), None, |handle, boot| {
                    handle.request(boot, Method::CommandInvoke, params)
                });
                self.dismiss_menu(window, cx);
            }
            Err(error) => {
                if let Some(palette) = &mut self.menu.palette {
                    palette.error = Some(error.to_string());
                }
                cx.notify();
            }
        }
    }

    /// Runs a daemon custom command on the focused workspace, tab, and pane,
    /// as choosing it in the palette does; a shortcut has no palette to
    /// report a refusal in, so it reads as a local error instead.
    pub(crate) fn invoke_custom_command(
        &mut self,
        id: &str,
        action: ClientShellCommandAction,
        cx: &mut Context<Self>,
    ) {
        if self.activation_deadline.is_some()
            || !self.endpoints[self.selected_endpoint].surface_requested()
        {
            return;
        }
        let result = (|| {
            if !self.input_ready() {
                return Err(Error::PaletteConnectionNotReady);
            }
            let snapshot = self.live.snapshot.as_ref().ok_or(Error::NoSnapshot)?;
            Target::capture(snapshot).invocation(snapshot, id, action)
        })();
        match result {
            Ok(params) => {
                self.request_focus_change(Method::CommandInvoke.as_str(), None, |handle, boot| {
                    handle.request(boot, Method::CommandInvoke, params)
                });
                self.discard_composition(cx);
            }
            Err(error) => self.local_error = Some(error.to_string()),
        }
        cx.notify();
    }

    /// Checks a Go To destination against its host's current snapshot, and
    /// reports whether that host is the selected one. Another host is selected
    /// by the navigation itself, which waits for its surface when needed.
    fn go_to_ready(
        &self,
        endpoint: &str,
        boot: &str,
        target: NavigationTarget<&str>,
    ) -> Result<bool> {
        let index = self
            .endpoints
            .iter()
            .position(|e| e.id == endpoint && e.enabled)
            .ok_or(Error::PaletteHostUnavailable)?;
        let selected = index == self.selected_endpoint;
        let live = if selected {
            &self.live
        } else {
            &self.endpoints[index].live
        };
        let snapshot = live
            .snapshot
            .as_ref()
            .ok_or(Error::PaletteHostUnavailable)?;
        destination_exists(snapshot, boot, target)?;
        if selected && !self.input_ready() {
            return Err(Error::PaletteConnectionNotReady);
        }
        Ok(selected)
    }

    pub(super) fn palette_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Herdr's navigate-mode keys move a Go To list as its arrows do.
        let step = match event.keystroke.key.as_str() {
            "up" => Some(true),
            "down" => Some(false),
            _ => self
                .menu
                .palette
                .as_ref()
                .filter(|palette| palette.filter == Filter::Navigation)
                .and_then(|_| self.keymap().navigates_workspace(&event.keystroke)),
        };
        let Some(palette) = &mut self.menu.palette else {
            return;
        };
        if palette.search.read(cx).is_composing() {
            return;
        }
        match event.keystroke.key.as_str() {
            "escape" => {
                cx.stop_propagation();
                window.prevent_default();
                self.dismiss_menu(window, cx);
            }
            _ if !palette.filtered.is_empty() && step.is_some() => {
                let up = step == Some(true);
                cx.stop_propagation();
                window.prevent_default();
                let count = palette.filtered.len();
                palette.selected = (palette.selected + if up { count - 1 } else { 1 }) % count;
                palette
                    .scroll
                    .scroll_to_item(palette.selected, ScrollStrategy::Center);
                cx.notify();
            }
            "tab" => {
                cx.stop_propagation();
                window.prevent_default();
                let index = Filter::ALL
                    .iter()
                    .position(|filter| *filter == palette.filter)
                    .unwrap_or(0);
                let step = if event.keystroke.modifiers.shift {
                    Filter::ALL.len() - 1
                } else {
                    1
                };
                let filter = Filter::ALL[(index + step) % Filter::ALL.len()];
                self.set_palette_filter(filter, cx);
            }
            "enter" => {
                cx.stop_propagation();
                window.prevent_default();
                if let Some(entry) = palette.selected_entry() {
                    let action = entry.action.clone();
                    self.activate_palette(action, window, cx);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
fn fixture_window(window: &mut Window, cx: &mut Context<HerdrWindow>) -> HerdrWindow {
    let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
    view.live.snapshot = Some(Arc::new(
        serde_json::from_str(include_str!(
            "../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap(),
    ));
    view.live.status = crate::state::ConnectionStatus::Connected;
    view.live.supports_surface = true;
    view.endpoints[0].live = view.live.clone();
    view
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
