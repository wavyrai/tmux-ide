//! Initial TUI command vocabulary; actions stay with their existing owners.
use super::{Row, Target, browser};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Action {
    Fonts,
    DeveloperMode(bool),
    Shortcuts,
    Help,
    WhatsNew,
    ToggleSidebar,
    Home,
    Terminals,
    AddMachine,
    SavedMachines,
    ManageMachines,
    LocalMachine,
    Sessions,
    Appearance,
    Refresh,
}
impl Action {
    pub(super) fn available(self, state: &browser::State) -> bool {
        self != Self::Appearance || state.appearance.is_some()
    }
}
#[cfg(test)]
pub(super) fn command_rows(state: &browser::State, query: &str) -> Vec<Row> {
    command_rows_with_sidebar(state, query, false)
}
#[cfg(test)]
pub(super) fn command_rows_with_sidebar(
    state: &browser::State,
    query: &str,
    hidden: bool,
) -> Vec<Row> {
    command_rows_with_settings(state, query, hidden, false)
}
pub(super) fn command_rows_with_settings(
    state: &browser::State,
    query: &str,
    hidden: bool,
    developer_mode: bool,
) -> Vec<Row> {
    let query: String = query.chars().take(256).collect::<String>().to_lowercase();
    let mut rows: Vec<Row> = [
        (
            Action::ToggleSidebar,
            if hidden {
                "Show sidebar · F10"
            } else {
                "Hide sidebar · F10"
            },
        ),
        (Action::Fonts, "Terminal font…"),
        (
            Action::DeveloperMode(!developer_mode),
            if developer_mode {
                "Disable Developer mode"
            } else {
                "Enable Developer mode"
            },
        ),
        (Action::Shortcuts, "Keyboard shortcuts…"),
        (Action::Help, "Using tmux-ide…"),
        (Action::WhatsNew, "What’s new…"),
        (Action::Home, "Home · F1"),
        (Action::Terminals, "Terminals · F2"),
        (Action::AddMachine, "Connect to machine…"),
        (Action::SavedMachines, "Switch saved machine…"),
        (Action::ManageMachines, "Manage saved machines…"),
        (
            Action::LocalMachine,
            "Use local machine / cancel connection",
        ),
        (Action::Sessions, "Switch session · F6"),
        (Action::Appearance, "Appearance…"),
        (Action::Refresh, "Refresh sessions"),
    ]
    .into_iter()
    .filter(|(_, label)| {
        query
            .split_whitespace()
            .all(|term| label.to_lowercase().contains(term))
    })
    .map(|(action, label)| Row {
        target: Target::Command(action),
        label: label.into(),
    })
    .collect();
    rows.extend(super::navigation_commands::rows(state, &query));
    rows.extend(super::pane_commands::rows(state, &query));
    rows.extend(super::fleet_servers::rows(state, &query));
    if let Some(fleet) = &state.fleet {
        for group in &fleet.groups {
            if let Some(token) = &group.retry {
                let label = format!("Retry machine · {}", group.label);
                if query
                    .split_whitespace()
                    .all(|term| label.to_lowercase().contains(term))
                {
                    rows.push(Row {
                        target: Target::FleetRetry(token.clone()),
                        label,
                    });
                }
            }
            if let Some(token) = &group.disconnect {
                let label = format!("Disconnect machine · {}", group.label);
                if query
                    .split_whitespace()
                    .all(|term| label.to_lowercase().contains(term))
                {
                    rows.push(Row {
                        target: Target::FleetDisconnect(token.clone()),
                        label,
                    });
                }
            }
        }
    }
    rows
}
pub(in crate::tmux_snapshot) fn shortcut(key: &gpui::Keystroke) -> bool {
    matches!(key.key.as_str(), "f1" | "f2" | "f5" | "f6" | "f7" | "f10")
        && !key.modifiers.platform
        && !key.modifiers.control
        && !key.modifiers.alt
        && !key.modifiers.shift
}
