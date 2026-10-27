//! The native menu bar. Every item dispatches the same `Command` the palette
//! and the keymap use, so a command exists in one place only.

use crate::{
    CheckForUpdates, Quit, RunCommand, ShowLogs,
    actions::{Copy, Cut, Paste, SelectAll, SetLayout},
    config::{Layout, LayoutMode},
    controls::Command,
};
#[cfg(target_os = "macos")]
use crate::{Hide, HideOthers, Minimize, ShowAll};
#[cfg(feature = "qa-menu")]
use crate::{
    PlaySound, ShowHerdrNotDetected, ShowUpdatePreview,
    actions::{
        RingBellPreview, ShowToastPreview, ShowUpdateDownloadPreview, ShowUpdateHomebrewPreview,
    },
};
use gpui::{App, Menu, MenuItem, OsAction};
#[cfg(feature = "qa-menu")]
use herdr_client::protocol::SemanticNotificationKind;

/// Installs the menu bar, checking the layout the latest config picked.
pub(crate) fn install(cx: &mut App) {
    let layout = cx
        .try_global::<crate::app::InitialAppearance>()
        .map_or_else(Layout::default, |appearance| appearance.config.layout);
    cx.set_menus(menus(layout));
}

/// View > Layout: Herdr's densities, their rounded versions, then the
/// layouts with a design of their own, the one in use checked.
fn layout_menu(current: LayoutMode) -> MenuItem {
    let items = LayoutMode::ALL
        .iter()
        .enumerate()
        .flat_map(|(index, &mode)| {
            let group = matches!(index, 3 | 6).then(MenuItem::separator);
            group.into_iter().chain([
                MenuItem::action(mode.label(), SetLayout { mode }).checked(mode == current)
            ])
        });
    MenuItem::submenu(Menu::new("Layout").items(items))
}

/// The menu bar, with `layout`'s mode checked under View > Layout.
pub(crate) fn menus(layout: Layout) -> Vec<Menu> {
    vec![
        Menu {
            name: "Herdr".into(),
            disabled: false,
            items: vec![
                MenuItem::action(
                    "About Herdr",
                    RunCommand {
                        command: Command::About,
                    },
                ),
                MenuItem::separator(),
                MenuItem::action(
                    "Command Palette",
                    RunCommand {
                        command: Command::Palette,
                    },
                ),
                MenuItem::action(
                    "Settings",
                    RunCommand {
                        command: Command::Settings,
                    },
                ),
                MenuItem::action(
                    "Keyboard Shortcuts",
                    RunCommand {
                        command: Command::Keybinds,
                    },
                ),
                MenuItem::action("Check for Updates...", CheckForUpdates),
                // macOS reserves Hide for every app; without these items
                // Cmd-H has no key equivalent and does nothing.
                #[cfg(target_os = "macos")]
                MenuItem::separator(),
                #[cfg(target_os = "macos")]
                MenuItem::action("Hide Herdr", Hide),
                #[cfg(target_os = "macos")]
                MenuItem::action("Hide Others", HideOthers),
                #[cfg(target_os = "macos")]
                MenuItem::action("Show All", ShowAll),
                MenuItem::separator(),
                MenuItem::action("Quit Herdr", Quit),
            ],
        },
        Menu {
            name: "File".into(),
            disabled: false,
            items: vec![
                MenuItem::action(
                    "New Workspace",
                    RunCommand {
                        command: Command::Workspace,
                    },
                ),
                MenuItem::action(
                    "New Worktree...",
                    RunCommand {
                        command: Command::NewWorktree,
                    },
                ),
                MenuItem::action(
                    "New Tab",
                    RunCommand {
                        command: Command::Tab,
                    },
                ),
                MenuItem::action(
                    "Go To",
                    RunCommand {
                        command: Command::WorkspacePicker,
                    },
                ),
                MenuItem::separator(),
                MenuItem::action(
                    "Close Pane...",
                    RunCommand {
                        command: Command::ClosePane,
                    },
                ),
                MenuItem::action(
                    "Close Tab...",
                    RunCommand {
                        command: Command::CloseTab,
                    },
                ),
            ],
        },
        // OS actions also route these items to native text fields, such as
        // the file panels, the way every macOS app's Edit menu does.
        Menu {
            name: "Edit".into(),
            disabled: false,
            items: vec![
                MenuItem::os_action("Cut", Cut, OsAction::Cut),
                MenuItem::os_action("Copy", Copy, OsAction::Copy),
                MenuItem::os_action("Paste", Paste, OsAction::Paste),
                MenuItem::separator(),
                MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
            ],
        },
        Menu {
            name: "View".into(),
            disabled: false,
            items: vec![
                MenuItem::action(
                    "Increase Font Size",
                    RunCommand {
                        command: Command::IncreaseFontSize,
                    },
                ),
                MenuItem::action(
                    "Decrease Font Size",
                    RunCommand {
                        command: Command::DecreaseFontSize,
                    },
                ),
                MenuItem::separator(),
                MenuItem::action(
                    "Reset Font Size",
                    RunCommand {
                        command: Command::ResetFontSize,
                    },
                ),
                MenuItem::separator(),
                layout_menu(layout.mode),
                MenuItem::separator(),
                MenuItem::action(
                    "Toggle Full Screen",
                    RunCommand {
                        command: Command::ToggleFullScreen,
                    },
                ),
            ],
        },
        Menu {
            name: "Terminal".into(),
            disabled: false,
            items: vec![
                MenuItem::action(
                    "Split Vertically (Right)",
                    RunCommand {
                        command: Command::SplitRight,
                    },
                ),
                MenuItem::action(
                    "Split Horizontally (Down)",
                    RunCommand {
                        command: Command::SplitDown,
                    },
                ),
                MenuItem::separator(),
                MenuItem::action(
                    "Next Tab",
                    RunCommand {
                        command: Command::NextTab,
                    },
                ),
                MenuItem::action(
                    "Previous Tab",
                    RunCommand {
                        command: Command::PreviousTab,
                    },
                ),
                MenuItem::action(
                    "Toggle Pane Zoom",
                    RunCommand {
                        command: Command::Zoom,
                    },
                ),
                MenuItem::action(
                    "Clear Pane",
                    RunCommand {
                        command: Command::ClearPane,
                    },
                ),
                MenuItem::action(
                    "Find",
                    RunCommand {
                        command: Command::Find,
                    },
                ),
                MenuItem::action(
                    "Find Next",
                    RunCommand {
                        command: Command::FindNext,
                    },
                ),
                MenuItem::action(
                    "Find Previous",
                    RunCommand {
                        command: Command::FindPrevious,
                    },
                ),
                MenuItem::action(
                    "Copy Mode",
                    RunCommand {
                        command: Command::CopyMode,
                    },
                ),
                MenuItem::action(
                    "Open Scrollback in Editor",
                    RunCommand {
                        command: Command::EditScrollback,
                    },
                ),
                MenuItem::action(
                    "Open Notification Target",
                    RunCommand {
                        command: Command::OpenNotificationTarget,
                    },
                ),
                MenuItem::action(
                    "Toggle Sidebar",
                    RunCommand {
                        command: Command::ToggleSidebar,
                    },
                ),
                MenuItem::action(
                    "Toggle Status Bar",
                    RunCommand {
                        command: Command::ToggleStatusBar,
                    },
                ),
                MenuItem::separator(),
                MenuItem::action(
                    "Reconnect",
                    RunCommand {
                        command: Command::Reconnect,
                    },
                ),
            ],
        },
        Menu {
            name: "Window".into(),
            disabled: false,
            items: vec![
                // Without this item Cmd-M has no key equivalent and does
                // nothing; the pane zoom above is unrelated to the window.
                #[cfg(target_os = "macos")]
                MenuItem::action("Minimize", Minimize),
                #[cfg(target_os = "macos")]
                MenuItem::separator(),
                MenuItem::action(
                    "New Window",
                    RunCommand {
                        command: Command::NewWindow,
                    },
                ),
                MenuItem::action(
                    "Cycle Through Windows",
                    RunCommand {
                        command: Command::CycleWindows,
                    },
                ),
                MenuItem::separator(),
                MenuItem::action("Logs", ShowLogs),
            ],
        },
        #[cfg(feature = "qa-menu")]
        Menu {
            name: "QA".into(),
            disabled: false,
            items: vec![
                MenuItem::action("Show herdr non-detected modal", ShowHerdrNotDetected),
                MenuItem::action("Show app update available", ShowUpdatePreview),
                MenuItem::action(
                    "Show update download progress (50%)",
                    ShowUpdateDownloadPreview,
                ),
                MenuItem::action("Show Homebrew update progress", ShowUpdateHomebrewPreview),
                MenuItem::action("Play Sound", PlaySound),
                MenuItem::action("Ring Bell in 3 Seconds", RingBellPreview),
                #[cfg(target_os = "macos")]
                MenuItem::action(
                    "Enable badge",
                    crate::actions::SetBadgePreview { enabled: true },
                ),
                #[cfg(target_os = "macos")]
                MenuItem::action(
                    "Disable badge preview",
                    crate::actions::SetBadgePreview { enabled: false },
                ),
                MenuItem::separator(),
                MenuItem::action(
                    "Show NeedsAttention toast",
                    ShowToastPreview {
                        kind: SemanticNotificationKind::NeedsAttention,
                    },
                ),
                MenuItem::action(
                    "Show Finished toast",
                    ShowToastPreview {
                        kind: SemanticNotificationKind::Finished,
                    },
                ),
                MenuItem::action(
                    "Show UpdateInstalled toast",
                    ShowToastPreview {
                        kind: SemanticNotificationKind::UpdateInstalled,
                    },
                ),
                MenuItem::action(
                    "Show Custom toast",
                    ShowToastPreview {
                        kind: SemanticNotificationKind::Custom,
                    },
                ),
                MenuItem::separator(),
                MenuItem::action(
                    "Send notification in 3 seconds",
                    crate::actions::ShowSystemNotificationPreview,
                ),
            ],
        },
    ]
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
