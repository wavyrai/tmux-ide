//! The endpoint API methods this client invokes.
//!
//! The daemon's advertised method list stays an open `Vec<String>` on the wire,
//! because a peer may offer methods this client knows nothing about. What is
//! closed is the set this client can *send*, so that set is an enum: a method
//! name reaches the wire through `as_str` in exactly one place, and a typo is a
//! compile error instead of an `UnsupportedMethod` rejection at runtime.

/// An endpoint API method. `as_str` is the wire spelling, and the only place a
/// method name is written out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Method {
    ClientShellSurfaceSet,
    CommandInvoke,
    IntegrationList,
    IntegrationInstall,
    LayoutSetSplitRatio,
    PaneClear,
    PaneClose,
    PaneCopyMotion,
    PaneCopySearch,
    PaneEditScrollback,
    PaneFocus,
    PaneFocusDirection,
    PaneInputSet,
    PaneLinkActivate,
    PaneLinkResolve,
    PaneRename,
    PaneResize,
    PaneScroll,
    PaneSelectionRead,
    PaneSplit,
    PaneSwap,
    PaneZoom,
    ProductAnnouncementDismiss,
    ReleaseNotesDismiss,
    ServerReloadConfig,
    TabClose,
    TabCreate,
    TabFocus,
    TabMove,
    TabRename,
    WorkspaceClose,
    WorkspaceCreate,
    WorkspaceFocus,
    WorkspaceMoveBlock,
    WorkspaceRename,
    WorktreeCreate,
    WorktreeList,
    WorktreeOpen,
    WorktreeRemove,
}

impl Method {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClientShellSurfaceSet => "client_shell.surface.set",
            Self::CommandInvoke => "command.invoke",
            Self::IntegrationList => "integration.list",
            Self::IntegrationInstall => "integration.install",
            Self::LayoutSetSplitRatio => "layout.set_split_ratio",
            Self::PaneClear => "pane.clear",
            Self::PaneClose => "pane.close",
            Self::PaneCopyMotion => "pane.copy_motion",
            Self::PaneCopySearch => "pane.copy_search",
            Self::PaneEditScrollback => "pane.edit_scrollback",
            Self::PaneFocus => "pane.focus",
            Self::PaneFocusDirection => "pane.focus_direction",
            Self::PaneInputSet => "pane.input.set",
            Self::PaneLinkActivate => "pane.link.activate",
            Self::PaneLinkResolve => "pane.link.resolve",
            Self::PaneRename => "pane.rename",
            Self::PaneResize => "pane.resize",
            Self::PaneScroll => "pane.scroll",
            Self::PaneSelectionRead => "pane.selection.read",
            Self::PaneSplit => "pane.split",
            Self::PaneSwap => "pane.swap",
            Self::PaneZoom => "pane.zoom",
            Self::ProductAnnouncementDismiss => "product_announcement.dismiss",
            Self::ReleaseNotesDismiss => "release_notes.dismiss",
            Self::ServerReloadConfig => "server.reload_config",
            Self::TabClose => "tab.close",
            Self::TabCreate => "tab.create",
            Self::TabFocus => "tab.focus",
            Self::TabMove => "tab.move",
            Self::TabRename => "tab.rename",
            Self::WorkspaceClose => "workspace.close",
            Self::WorkspaceCreate => "workspace.create",
            Self::WorkspaceFocus => "workspace.focus",
            Self::WorkspaceMoveBlock => "workspace.move_block",
            Self::WorkspaceRename => "workspace.rename",
            Self::WorktreeCreate => "worktree.create",
            Self::WorktreeList => "worktree.list",
            Self::WorktreeOpen => "worktree.open",
            Self::WorktreeRemove => "worktree.remove",
        }
    }

    /// Whether a peer's advertised method list contains this method. The list
    /// is remote data, so it is compared as text rather than parsed.
    pub fn advertised_in(self, methods: &[String]) -> bool {
        methods.iter().any(|method| method == self.as_str())
    }
}

impl std::fmt::Display for Method {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests;
