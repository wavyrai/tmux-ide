//! What a menu popup is currently showing, and the workspace actions a row
//! can trigger. Closed sets, so a page is never a string tag.

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Page {
    Menu,
    About,
    Preferences,
    Devices,
    /// Local sessions and remote devices, with the state of each.
    Sessions,
    /// Plan usage details for one agent on the selected host.
    Usage(crate::usage::Provider),
    AddDevice,
    /// A saved SSH device's context menu, from its sidebar host header.
    Host,
    RenameDevice,
    /// Names a saved SSH device's port to forward to this computer.
    ForwardPort,
    RemoveDevice,
    /// Sign in to Coder and add one of its workspaces as a device.
    #[cfg(feature = "coder")]
    AddCoder,
    /// Picking a WSL distribution to save as a device.
    AddWsl,
    /// Confirming a saved WSL distribution should be forgotten.
    RemoveWsl,
    Keybinds,
    Themes,
    Fonts,
    Palette,
    ConfirmClose,
    Update,
    AppUpdate,
    Install,
    /// A daemon refused the handshake until one side is updated.
    VersionMismatch,
    /// The one-time offer to install the agent skill for browser tabs.
    AgentSkill,
    Tab,
    RenameTab,
    /// A group's "…" menu: opening tabs other than a terminal, closing
    /// tabs, and splitting.
    Group,
    Pane,
    RenamePane,
    /// The processes under the pane menu's pane.
    PaneProcesses,
    /// Confirming the processes chosen there should end.
    KillProcesses,
    Workspace,
    GitHub,
    /// Titlebar Git actions for the focused checkout, and its commit dialog.
    Git,
    GitCommit,
    /// The open pull request's checks and review conversation.
    PrReview,
    PrComment,
    /// Choosing a merge method, and confirming it.
    PrMerge,
    Dialog(WorkspaceAction),
    /// Moving a linked worktree to another host.
    Teleport,
    /// A checkout's agent checkpoints, and restoring one.
    Checkpoints,
    /// One prompt sent to several agents, and their comparison.
    FanOut,
    /// Asks whether to trust a repository's worktree script before it runs.
    WorktreeScript,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceAction {
    Rename,
    Close,
    NewWorktree,
    OpenWorktree,
    DeleteWorktree,
    /// Names a tab before `tab.create`, when `ui.prompt_new_tab_name` asks.
    NewTab,
    /// Names a workspace before `workspace.create`, when
    /// `ui.prompt_new_workspace_name` asks. Targets the source workspace.
    NewWorkspace,
    /// Writes the note this app keeps on the checkout; never a daemon request.
    Note,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceMenuAction {
    Dialog(WorkspaceAction),
    /// Fold or unfold the worktree group this workspace heads. Applied at once:
    /// it changes only the sidebar's own view, never the daemon's state.
    Collapse,
    Expand,
    PullRequest,
    Teleport,
    /// Teleport the work back to the host it came from.
    TeleportBack,
    /// Focus the copy the work was teleported to.
    GoToTeleported,
    /// Forget that this checkout's work was teleported away.
    ClearTeleported,
    Checkpoints,
    /// Send one prompt to several agents, or reopen their comparison.
    FanOut,
    /// Run one of the repository's worktree scripts in a new tab.
    Script(crate::worktree_scripts::ScriptKind),
}

impl WorkspaceMenuAction {
    /// Embedded icon for the row, so each action is recognizable before reading.
    /// The pull request section draws its own header rather than a menu row.
    pub(crate) fn icon(self) -> Option<&'static str> {
        Some(match self {
            Self::Dialog(WorkspaceAction::Rename) => "icons/pencil.svg",
            Self::Dialog(WorkspaceAction::Close) => "icons/close.svg",
            Self::Dialog(WorkspaceAction::NewWorktree) => "icons/plus.svg",
            Self::Dialog(WorkspaceAction::OpenWorktree) => "icons/chevron-down.svg",
            Self::Dialog(WorkspaceAction::DeleteWorktree) => "icons/trash.svg",
            Self::Dialog(WorkspaceAction::Note) => "icons/note.svg",
            Self::Dialog(WorkspaceAction::NewTab | WorkspaceAction::NewWorkspace) => {
                "icons/plus.svg"
            }
            Self::Collapse => "icons/chevron-up.svg",
            Self::Expand => "icons/chevron-down.svg",
            Self::Teleport | Self::GoToTeleported => "icons/teleport.svg",
            Self::TeleportBack => "icons/teleport-back.svg",
            Self::ClearTeleported => "icons/x.svg",
            Self::Checkpoints => "icons/refresh.svg",
            Self::FanOut => "icons/fan-out.svg",
            Self::Script(crate::worktree_scripts::ScriptKind::Setup) => "icons/refresh.svg",
            Self::Script(_) => "icons/play.svg",
            Self::PullRequest => return None,
        })
    }
}
