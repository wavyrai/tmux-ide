use herdr_client::{Method, protocol::ClientShellSnapshot};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Deserialize)]
pub enum Command {
    NewWindow,
    Workspace,
    NewWorktree,
    /// Go To, listing only the checkouts that have a note.
    WorktreeNotes,
    /// The focused checkout's note.
    EditWorktreeNote,
    Tab,
    SplitRight,
    SplitDown,
    NextTab,
    PreviousTab,
    FocusLeft,
    FocusRight,
    FocusUp,
    FocusDown,
    NextPane,
    PreviousPane,
    Zoom,
    ClearPane,
    Find,
    FindNext,
    FindPrevious,
    CopyMode,
    EditScrollback,
    ClosePane,
    CloseTab,
    TabNumber(u8),
    ToggleSidebar,
    ToggleStatusBar,
    IncreaseFontSize,
    DecreaseFontSize,
    ResetFontSize,
    Settings,
    Keybinds,
    Sessions,
    Themes,
    WorkspacePicker,
    Palette,
    Reconnect,
    Quit,
    Logs,
    About,
    OpenNotificationTarget,
    NewBrowserTab,
    InstallBrowserSkill,
    SplitEditor,
    ToggleFullScreen,
    CycleWindows,
    MoveTabPrevious,
    MoveTabNext,
    RenameTab,
    LastPane,
    SwapLeft,
    SwapRight,
    SwapUp,
    SwapDown,
    ResizeLeft,
    ResizeRight,
    ResizeUp,
    ResizeDown,
    ResizeMode,
    RenamePane,
    PreviousWorkspace,
    NextWorkspace,
    WorkspaceNumber(u8),
    RenameWorkspace,
    CloseWorkspace,
    PreviousAgent,
    NextAgent,
    AgentNumber(u8),
    ReloadConfig,
}

pub struct CommandInfo {
    pub command: Command,
    /// The key naming this command in the config file's `[keybindings]`.
    pub name: &'static str,
    pub label: &'static str,
    /// Default keystrokes, primary first. The config can replace each list.
    pub shortcuts: &'static [&'static str],
}

pub const COMMANDS: &[CommandInfo] = &[
    CommandInfo {
        command: Command::OpenNotificationTarget,
        name: "open_notification_target",
        label: "Open Notification Target",
        shortcuts: &["cmd-alt-n"],
    },
    CommandInfo {
        command: Command::Logs,
        name: "logs",
        label: "Logs",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::NewWindow,
        name: "new_window",
        label: "New Window",
        shortcuts: &["cmd-alt-shift-n"],
    },
    CommandInfo {
        command: Command::Workspace,
        name: "new_workspace",
        label: "New Workspace",
        shortcuts: &["cmd-shift-n"],
    },
    CommandInfo {
        command: Command::NewWorktree,
        name: "new_worktree",
        label: "New Worktree",
        shortcuts: &["cmd-n"],
    },
    CommandInfo {
        command: Command::WorktreeNotes,
        name: "worktree_notes",
        label: "Worktree Notes",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::EditWorktreeNote,
        name: "edit_worktree_note",
        label: "Edit Worktree Note",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::PreviousWorkspace,
        name: "previous_workspace",
        label: "Previous Workspace",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::NextWorkspace,
        name: "next_workspace",
        label: "Next Workspace",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(1),
        name: "focus_workspace_1",
        label: "Focus Workspace 1",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(2),
        name: "focus_workspace_2",
        label: "Focus Workspace 2",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(3),
        name: "focus_workspace_3",
        label: "Focus Workspace 3",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(4),
        name: "focus_workspace_4",
        label: "Focus Workspace 4",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(5),
        name: "focus_workspace_5",
        label: "Focus Workspace 5",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(6),
        name: "focus_workspace_6",
        label: "Focus Workspace 6",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(7),
        name: "focus_workspace_7",
        label: "Focus Workspace 7",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(8),
        name: "focus_workspace_8",
        label: "Focus Workspace 8",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspaceNumber(9),
        name: "focus_workspace_9",
        label: "Focus Workspace 9",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::RenameWorkspace,
        name: "rename_workspace",
        label: "Rename Workspace",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::CloseWorkspace,
        name: "close_workspace",
        label: "Close Workspace",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::Tab,
        name: "new_tab",
        label: "New Tab",
        shortcuts: &["cmd-t"],
    },
    CommandInfo {
        command: Command::SplitRight,
        name: "split_right",
        label: "Split Right",
        shortcuts: &["cmd-d"],
    },
    CommandInfo {
        command: Command::SplitDown,
        name: "split_down",
        label: "Split Down",
        shortcuts: &["cmd-shift-d"],
    },
    CommandInfo {
        command: Command::NextTab,
        name: "next_tab",
        label: "Next Tab",
        shortcuts: &["cmd-shift-]"],
    },
    CommandInfo {
        command: Command::PreviousTab,
        name: "previous_tab",
        label: "Previous Tab",
        shortcuts: &["cmd-shift-["],
    },
    CommandInfo {
        command: Command::MoveTabPrevious,
        name: "move_tab_previous",
        label: "Move Tab Left",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::MoveTabNext,
        name: "move_tab_next",
        label: "Move Tab Right",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::RenameTab,
        name: "rename_tab",
        label: "Rename Tab",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::FocusLeft,
        name: "focus_left",
        label: "Focus Left",
        shortcuts: &["cmd-alt-left"],
    },
    CommandInfo {
        command: Command::FocusRight,
        name: "focus_right",
        label: "Focus Right",
        shortcuts: &["cmd-alt-right"],
    },
    CommandInfo {
        command: Command::FocusUp,
        name: "focus_up",
        label: "Focus Up",
        shortcuts: &["cmd-alt-up"],
    },
    CommandInfo {
        command: Command::FocusDown,
        name: "focus_down",
        label: "Focus Down",
        shortcuts: &["cmd-alt-down"],
    },
    CommandInfo {
        command: Command::NextPane,
        name: "next_pane",
        label: "Next Pane",
        shortcuts: &["cmd-alt-]"],
    },
    CommandInfo {
        command: Command::PreviousPane,
        name: "previous_pane",
        label: "Previous Pane",
        shortcuts: &["cmd-alt-["],
    },
    CommandInfo {
        command: Command::LastPane,
        name: "last_pane",
        label: "Last Pane",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::SwapLeft,
        name: "swap_pane_left",
        label: "Swap Pane Left",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::SwapRight,
        name: "swap_pane_right",
        label: "Swap Pane Right",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::SwapUp,
        name: "swap_pane_up",
        label: "Swap Pane Up",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::SwapDown,
        name: "swap_pane_down",
        label: "Swap Pane Down",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::ResizeLeft,
        name: "resize_pane_left",
        label: "Resize Pane Left",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::ResizeRight,
        name: "resize_pane_right",
        label: "Resize Pane Right",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::ResizeUp,
        name: "resize_pane_up",
        label: "Resize Pane Up",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::ResizeDown,
        name: "resize_pane_down",
        label: "Resize Pane Down",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::ResizeMode,
        name: "resize_mode",
        label: "Resize Mode",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::RenamePane,
        name: "rename_pane",
        label: "Rename Pane",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::Zoom,
        name: "toggle_zoom",
        label: "Toggle Pane Zoom",
        shortcuts: &["cmd-shift-enter"],
    },
    CommandInfo {
        command: Command::ClearPane,
        name: "clear_pane",
        label: "Clear Pane",
        shortcuts: &["cmd-k"],
    },
    CommandInfo {
        command: Command::Find,
        name: "find",
        label: "Find",
        shortcuts: &["cmd-f"],
    },
    CommandInfo {
        command: Command::FindNext,
        name: "find_next",
        label: "Find Next",
        shortcuts: &["cmd-g"],
    },
    CommandInfo {
        command: Command::FindPrevious,
        name: "find_previous",
        label: "Find Previous",
        shortcuts: &["cmd-shift-g"],
    },
    CommandInfo {
        command: Command::CopyMode,
        name: "copy_mode",
        label: "Copy Mode",
        shortcuts: &["cmd-shift-c"],
    },
    CommandInfo {
        command: Command::EditScrollback,
        name: "edit_scrollback",
        label: "Open Scrollback in Editor",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::ClosePane,
        name: "close_pane",
        label: "Close Pane",
        shortcuts: &["cmd-w"],
    },
    CommandInfo {
        command: Command::CloseTab,
        name: "close_tab",
        label: "Close Tab",
        shortcuts: &["cmd-shift-w"],
    },
    CommandInfo {
        command: Command::TabNumber(1),
        name: "focus_tab_1",
        label: "Focus Tab 1",
        shortcuts: &["cmd-1"],
    },
    CommandInfo {
        command: Command::TabNumber(2),
        name: "focus_tab_2",
        label: "Focus Tab 2",
        shortcuts: &["cmd-2"],
    },
    CommandInfo {
        command: Command::TabNumber(3),
        name: "focus_tab_3",
        label: "Focus Tab 3",
        shortcuts: &["cmd-3"],
    },
    CommandInfo {
        command: Command::TabNumber(4),
        name: "focus_tab_4",
        label: "Focus Tab 4",
        shortcuts: &["cmd-4"],
    },
    CommandInfo {
        command: Command::TabNumber(5),
        name: "focus_tab_5",
        label: "Focus Tab 5",
        shortcuts: &["cmd-5"],
    },
    CommandInfo {
        command: Command::TabNumber(6),
        name: "focus_tab_6",
        label: "Focus Tab 6",
        shortcuts: &["cmd-6"],
    },
    CommandInfo {
        command: Command::TabNumber(7),
        name: "focus_tab_7",
        label: "Focus Tab 7",
        shortcuts: &["cmd-7"],
    },
    CommandInfo {
        command: Command::TabNumber(8),
        name: "focus_tab_8",
        label: "Focus Tab 8",
        shortcuts: &["cmd-8"],
    },
    CommandInfo {
        command: Command::TabNumber(9),
        name: "focus_tab_9",
        label: "Focus Tab 9",
        shortcuts: &["cmd-9"],
    },
    CommandInfo {
        command: Command::PreviousAgent,
        name: "previous_agent",
        label: "Previous Agent",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::NextAgent,
        name: "next_agent",
        label: "Next Agent",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(1),
        name: "focus_agent_1",
        label: "Focus Agent 1",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(2),
        name: "focus_agent_2",
        label: "Focus Agent 2",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(3),
        name: "focus_agent_3",
        label: "Focus Agent 3",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(4),
        name: "focus_agent_4",
        label: "Focus Agent 4",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(5),
        name: "focus_agent_5",
        label: "Focus Agent 5",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(6),
        name: "focus_agent_6",
        label: "Focus Agent 6",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(7),
        name: "focus_agent_7",
        label: "Focus Agent 7",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(8),
        name: "focus_agent_8",
        label: "Focus Agent 8",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::AgentNumber(9),
        name: "focus_agent_9",
        label: "Focus Agent 9",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::ToggleSidebar,
        name: "toggle_sidebar",
        label: "Toggle Sidebar",
        shortcuts: &["cmd-b"],
    },
    CommandInfo {
        command: Command::ToggleStatusBar,
        name: "toggle_status_bar",
        label: "Toggle Status Bar",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::IncreaseFontSize,
        name: "increase_font_size",
        label: "Increase Font Size",
        shortcuts: &["cmd-=", "cmd-+"],
    },
    CommandInfo {
        command: Command::DecreaseFontSize,
        name: "decrease_font_size",
        label: "Decrease Font Size",
        shortcuts: &["cmd--"],
    },
    CommandInfo {
        command: Command::ResetFontSize,
        name: "reset_font_size",
        label: "Reset Font Size",
        shortcuts: &["cmd-0"],
    },
    CommandInfo {
        command: Command::Settings,
        name: "settings",
        label: "Settings",
        shortcuts: &["cmd-,"],
    },
    CommandInfo {
        command: Command::ReloadConfig,
        name: "reload_config",
        label: "Reload Config",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::Keybinds,
        name: "keybindings",
        label: "Keyboard Shortcuts",
        shortcuts: &["cmd-/"],
    },
    CommandInfo {
        command: Command::Sessions,
        name: "sessions",
        label: "Sessions",
        shortcuts: &["cmd-shift-s"],
    },
    CommandInfo {
        command: Command::Themes,
        name: "themes",
        label: "Themes",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::WorkspacePicker,
        name: "workspace_picker",
        label: "Go To",
        shortcuts: &["cmd-p"],
    },
    CommandInfo {
        command: Command::Palette,
        name: "command_palette",
        label: "Command Palette",
        shortcuts: &["cmd-shift-p"],
    },
    CommandInfo {
        command: Command::Reconnect,
        name: "reconnect",
        label: "Reconnect",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::Quit,
        name: "quit",
        label: "Quit",
        shortcuts: &["cmd-q"],
    },
    CommandInfo {
        command: Command::About,
        name: "about",
        label: "About Herdr",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::NewBrowserTab,
        name: "new_browser_tab",
        label: "New Browser Tab",
        shortcuts: &["cmd-shift-b"],
    },
    CommandInfo {
        command: Command::InstallBrowserSkill,
        name: "install_browser_skill",
        label: "Install Browser Skill for Agents",
        shortcuts: &[],
    },
    CommandInfo {
        command: Command::SplitEditor,
        name: "split_editor",
        label: "Split Editor",
        shortcuts: &["cmd-\\"],
    },
    CommandInfo {
        command: Command::ToggleFullScreen,
        name: "toggle_full_screen",
        label: "Toggle Full Screen",
        shortcuts: &["ctrl-cmd-f"],
    },
    CommandInfo {
        command: Command::CycleWindows,
        name: "cycle_windows",
        label: "Cycle Through Windows",
        shortcuts: &["cmd-`"],
    },
];

pub fn request(command: Command, snapshot: &ClientShellSnapshot) -> Option<(Method, Value)> {
    let workspace = snapshot
        .workspaces
        .iter()
        .find(|w| Some(&w.workspace_id) == snapshot.focused_workspace_id.as_ref());
    let tab = workspace.and_then(|w| {
        snapshot.tabs.iter().find(|t| {
            Some(&t.tab_id) == snapshot.focused_tab_id.as_ref() && t.workspace_id == w.workspace_id
        })
    });
    let pane = tab.and_then(|t| {
        snapshot.panes.iter().find(|p| {
            Some(&p.pane_id) == snapshot.focused_pane_id.as_ref()
                && p.tab_id == t.tab_id
                && p.workspace_id == t.workspace_id
        })
    });
    Some(match command {
        Command::Workspace => {
            let mut params = json!({"focus": true});
            if snapshot.focused_workspace_id.is_some() {
                params["source_workspace_id"] = json!(workspace?.workspace_id);
            }
            (Method::WorkspaceCreate, params)
        }
        Command::Tab => (
            Method::TabCreate,
            json!({"workspace_id": workspace?.workspace_id, "focus": true}),
        ),
        Command::SplitRight | Command::SplitDown => (
            Method::PaneSplit,
            json!({
                "target_pane_id": pane?.pane_id,
                "direction": if matches!(command, Command::SplitRight) { "right" } else { "down" },
                "focus": true,
            }),
        ),
        Command::NextTab | Command::PreviousTab => {
            let workspace = &workspace?.workspace_id;
            let tabs: Vec<_> = snapshot
                .tabs
                .iter()
                .filter(|t| &t.workspace_id == workspace)
                .collect();
            let index = tabs
                .iter()
                .position(|t| Some(&t.tab_id) == snapshot.focused_tab_id.as_ref())?;
            let next = if matches!(command, Command::NextTab) {
                (index + 1) % tabs.len()
            } else {
                (index + tabs.len() - 1) % tabs.len()
            };
            (Method::TabFocus, json!({"tab_id": tabs[next].tab_id}))
        }
        Command::FocusLeft | Command::FocusRight | Command::FocusUp | Command::FocusDown => (
            Method::PaneFocusDirection,
            json!({"pane_id": pane?.pane_id, "direction": direction(command)?}),
        ),
        // Herdr nudges the split by its own default step, as its TUI does.
        Command::ResizeLeft | Command::ResizeRight | Command::ResizeUp | Command::ResizeDown => (
            Method::PaneResize,
            json!({"pane_id": pane?.pane_id, "direction": direction(command)?}),
        ),
        Command::SwapLeft | Command::SwapRight | Command::SwapUp | Command::SwapDown => (
            Method::PaneSwap,
            json!({"pane_id": pane?.pane_id, "direction": direction(command)?}),
        ),
        Command::MoveTabPrevious | Command::MoveTabNext => {
            let tab = tab?;
            let tabs: Vec<_> = snapshot
                .tabs
                .iter()
                .filter(|t| t.workspace_id == tab.workspace_id)
                .collect();
            if tabs.len() <= 1 {
                return None;
            }
            let source = tabs.iter().position(|t| t.tab_id == tab.tab_id)?;
            // As Herdr's TUI moves it: the index counts the moving tab still
            // in place, and a tab at either end wraps around to the other.
            let insert_index = if command == Command::MoveTabNext {
                if source + 1 == tabs.len() {
                    0
                } else {
                    source + 2
                }
            } else if source == 0 {
                tabs.len()
            } else {
                source - 1
            };
            (
                Method::TabMove,
                json!({"tab_id": tab.tab_id, "insert_index": insert_index}),
            )
        }
        Command::NextPane | Command::PreviousPane => {
            let pane = pane?;
            let panes: Vec<_> = snapshot
                .panes
                .iter()
                .filter(|p| p.workspace_id == pane.workspace_id && p.tab_id == pane.tab_id)
                .collect();
            // Finding the current pane also guarantees a nonempty cycle.
            let index = panes.iter().position(|p| p.pane_id == pane.pane_id)?;
            let next = if command == Command::NextPane {
                (index + 1) % panes.len()
            } else {
                (index + panes.len() - 1) % panes.len()
            };
            (Method::PaneFocus, json!({"pane_id": panes[next].pane_id}))
        }
        Command::Zoom => (
            Method::PaneZoom,
            json!({"pane_id": pane?.pane_id, "mode": "toggle"}),
        ),
        Command::ClearPane => (Method::PaneClear, json!({"pane_id": pane?.pane_id})),
        Command::EditScrollback => (
            Method::PaneEditScrollback,
            json!({"pane_id": pane?.pane_id}),
        ),
        Command::ClosePane => (Method::PaneClose, json!({"pane_id": pane?.pane_id})),
        Command::CloseTab => (Method::TabClose, json!({"tab_id": tab?.tab_id})),
        // By position, as Herdr's `switch_tab` does: a tab's `number` is an
        // ID that is never reused, so it drifts from the strip once a tab closes.
        Command::TabNumber(number) => {
            let workspace = workspace?;
            let target = snapshot
                .tabs
                .iter()
                .filter(|t| t.workspace_id == workspace.workspace_id)
                .nth(usize::from(number).checked_sub(1)?)?;
            (Method::TabFocus, json!({"tab_id": target.tab_id}))
        }
        Command::NewWindow
        | Command::NewWorktree
        | Command::WorktreeNotes
        | Command::EditWorktreeNote
        | Command::Find
        | Command::FindNext
        | Command::FindPrevious
        | Command::CopyMode
        | Command::ToggleSidebar
        | Command::ToggleStatusBar
        | Command::IncreaseFontSize
        | Command::DecreaseFontSize
        | Command::ResetFontSize
        | Command::Settings
        | Command::Keybinds
        | Command::Sessions
        | Command::Themes
        | Command::WorkspacePicker
        | Command::Palette
        | Command::Reconnect
        | Command::Quit
        | Command::Logs
        | Command::About
        | Command::OpenNotificationTarget
        | Command::NewBrowserTab
        | Command::InstallBrowserSkill
        | Command::SplitEditor
        | Command::ToggleFullScreen
        | Command::CycleWindows
        // These need state beyond the snapshot, such as the sidebar's order
        // or a dialog, so the window runs them.
        | Command::RenameTab
        | Command::LastPane
        | Command::ResizeMode
        | Command::RenamePane
        | Command::PreviousWorkspace
        | Command::NextWorkspace
        | Command::WorkspaceNumber(_)
        | Command::RenameWorkspace
        | Command::CloseWorkspace
        | Command::PreviousAgent
        | Command::NextAgent
        | Command::AgentNumber(_)
        | Command::ReloadConfig => return None,
    })
}

/// The pane direction a directional command names.
fn direction(command: Command) -> Option<&'static str> {
    Some(match command {
        Command::FocusLeft | Command::SwapLeft | Command::ResizeLeft => "left",
        Command::FocusRight | Command::SwapRight | Command::ResizeRight => "right",
        Command::FocusUp | Command::SwapUp | Command::ResizeUp => "up",
        Command::FocusDown | Command::SwapDown | Command::ResizeDown => "down",
        _ => return None,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
