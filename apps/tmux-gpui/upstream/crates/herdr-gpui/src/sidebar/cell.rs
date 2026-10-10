//! Sidebar rows as swappable layouts.
//!
//! Render prepares what a row shows once, as typed data, and hands it to the
//! configured [`RowLayout`] through a [`Cell`]. The layout decides which of
//! those pieces appear and where: one can name the host and branch, another
//! only the name. The cell carries the row's state, so callers write
//! `cell.selected(focused).highlighted(menu_open).row()` and each layout
//! paints those states its own way.
//!
//! Rows are built and dropped within one render of the cached sidebar view, so
//! everything here borrows from the window rather than copying into owned
//! state: a layout costs one virtual call per row.

use super::{
    layout::SidebarLook,
    row::{RowBadge, RowIcon, RowLift, RowTree, Upstream},
};
use crate::{
    config::{FontConfig, LayoutMode, Theme},
    icons::AgentIcon,
};
use gpui::{App, ClickEvent, Div, ElementId, Window};
use herdr_client::protocol::{AgentStatus, ClientShellWorkspace};
use std::borrow::Cow;

/// Read-only inputs every row of one render shares.
pub(super) struct RowContext<'a> {
    pub(super) indicators: super::agents::Indicators,
    pub(super) font: &'a FontConfig,
    pub(super) theme: &'a Theme,
    /// Density and style: spacing, highlight shape, and which details show.
    pub(super) look: SidebarLook,
    /// Full sidebar width, divider included.
    pub(super) width: f32,
    /// How far workspace rows step in under their host's header: zero while
    /// a single host shows no header to nest under.
    pub(super) nest: f32,
    /// The host's colour wash and dimming, shared by every row it owns.
    pub(super) mark: super::wash::HostMark,
    /// The host these rows live on, named only while several hosts are
    /// listed and this one is remote, so a single-host sidebar stays quiet.
    pub(super) host: Option<&'a str>,
}

/// A click listener, erased so rows of every group share one type.
pub(super) type ClickHandler = dyn Fn(&ClickEvent, &mut Window, &mut App);

/// A repository's fold control. The layout draws it; render owns what
/// clicking it changes.
pub(super) struct Fold {
    pub(super) id: ElementId,
    /// Position of the row in its host's workspace list, for probes.
    pub(super) index: usize,
    pub(super) collapsed: bool,
    pub(super) toggle: Box<ClickHandler>,
}

pub(super) struct WorkspaceRow<'a> {
    pub(super) workspace: &'a ClientShellWorkspace,
    /// What the row is called: a child's branch unless the user renamed it.
    pub(super) label: &'a str,
    pub(super) tree: RowTree,
    pub(super) icon: RowIcon,
    pub(super) fold: Option<Fold>,
    /// Whether the row belongs to a worktree group, which lines its badges up
    /// with the group's fold control.
    pub(super) grouped: bool,
    pub(super) badge: Option<RowBadge>,
    /// The checkout is being deleted.
    pub(super) removing: bool,
    /// Status the row shows. A collapsed group's head takes its most urgent member.
    pub(super) status: AgentStatus,
    /// Daemon token rows, painted in the layout's own frame. Empty keeps its native lines.
    pub(super) lines: Vec<Vec<super::tokens::ResolvedToken>>,
}

impl<'a> WorkspaceRow<'a> {
    /// The checked-out branch, if Git reported a non-blank one.
    pub(super) fn branch(&self) -> Option<&'a str> {
        self.workspace
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
    }

    /// Commits to push and pull against the branch's upstream, if any.
    pub(super) fn upstream(&self) -> Option<Upstream> {
        Upstream::new(self.workspace.git_ahead_behind)
    }

    pub(super) fn status(&self) -> AgentStatus {
        self.status
    }
}

pub(super) struct AgentRow<'a> {
    /// Stable probe key, unique across both lists.
    pub(super) key: String,
    pub(super) name: &'a str,
    pub(super) icon: AgentIcon,
    pub(super) status: AgentStatus,
    /// Its workspace and, when that earns a place, its tab. Missing once the
    /// workspace has gone.
    pub(super) place: Option<(&'a str, Option<&'a str>)>,
    /// The daemon's `state_text` word when its sidebar config asks for it, so
    /// the GUI and the TUI name the status the same way: the agent's own
    /// state label when its integration set one.
    pub(super) status_text: Option<Cow<'a, str>>,
    /// Daemon token rows, painted in the layout's own frame. Empty keeps its native lines.
    pub(super) lines: Vec<Vec<super::tokens::ResolvedToken>>,
}

/// What a row shows.
pub(super) enum RowData<'a> {
    Workspace(WorkspaceRow<'a>),
    Agent(AgentRow<'a>),
}

/// How a row is marked. Hovering needs no state: layouts style it through
/// the row's hover group, so it costs nothing per frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct RowState {
    /// The focused workspace or agent.
    pub(super) selected: bool,
    /// Marked as if hovered while the pointer is elsewhere, such as the row a
    /// menu was opened for.
    pub(super) highlighted: bool,
    /// Whether a workspace is being dragged, and whether this is the row it
    /// carries. Rows the carried one passes stop answering hover; the carried
    /// row floats over them, so it must paint an opaque, lifted surface.
    pub(super) lift: RowLift,
}

/// Arranges a row's content and marks its state. Implementations are
/// stateless and read only what they are given, so render stays free of I/O
/// and allocation beyond the elements themselves. How a dragged row looks is
/// part of the layout too: `state.lift` says which row is carried.
pub(super) trait RowLayout {
    fn workspace(&self, row: WorkspaceRow<'_>, state: RowState, cx: &RowContext<'_>) -> Div;
    fn agent(&self, row: AgentRow<'_>, state: RowState, cx: &RowContext<'_>) -> Div;
}

/// One row waiting for its state: build it, mark it, then take the element.
#[must_use = "a cell draws nothing until `row` takes its element"]
pub(super) struct Cell<'a> {
    layout: &'a dyn RowLayout,
    data: RowData<'a>,
    state: RowState,
    cx: &'a RowContext<'a>,
}

impl<'a> Cell<'a> {
    pub(super) fn new(
        layout: &'a dyn RowLayout,
        data: RowData<'a>,
        cx: &'a RowContext<'a>,
    ) -> Self {
        Self {
            layout,
            data,
            state: RowState::default(),
            cx,
        }
    }

    pub(super) fn selected(mut self, selected: bool) -> Self {
        self.state.selected = selected;
        self
    }

    pub(super) fn highlighted(mut self, highlighted: bool) -> Self {
        self.state.highlighted = highlighted;
        self
    }

    pub(super) fn lift(mut self, lift: RowLift) -> Self {
        self.state.lift = lift;
        self
    }

    /// The row element, laid out for the state the cell was given.
    pub(super) fn row(self) -> Div {
        match self.data {
            RowData::Workspace(row) => self.layout.workspace(row, self.state, self.cx),
            RowData::Agent(row) => self.layout.agent(row, self.state, self.cx),
        }
    }
}

/// The rows a layout draws: Herdr's for every density, or a design of its own.
pub(super) fn layout_for(mode: LayoutMode) -> &'static dyn RowLayout {
    match mode {
        LayoutMode::Classic { .. } => &super::layouts::Herdr,
        LayoutMode::Superset => &super::layouts::Superset,
        LayoutMode::Orca => &super::layouts::Orca,
        LayoutMode::Minimal => &super::layouts::Minimal,
    }
}
