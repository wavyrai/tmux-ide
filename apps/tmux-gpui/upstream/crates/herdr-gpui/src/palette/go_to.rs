//! Go To rows: every workspace, tab, pane, and agent on each connected host,
//! the checkouts the user keeps notes on, and the check that a chosen
//! destination still exists.

use super::{Action, Entry, Source, projects};
use crate::{Error, NavigationTarget, Result};
use gpui::SharedString;
use herdr_client::protocol::{AgentStatus, ClientShellSnapshot};

/// Whether a Go To destination listed from `boot` still exists in `snapshot`.
pub(super) fn destination_exists(
    snapshot: &ClientShellSnapshot,
    boot: &str,
    target: NavigationTarget<&str>,
) -> Result<()> {
    if boot.is_empty() || boot != snapshot.boot_id {
        return Err(Error::PaletteSessionChanged);
    }
    match target {
        NavigationTarget::Workspace(id) => snapshot
            .workspaces
            .iter()
            .any(|w| w.workspace_id == id)
            .then_some(())
            .ok_or(Error::PaletteWorkspaceRemoved),
        NavigationTarget::Tab(id) => snapshot
            .tabs
            .iter()
            .any(|t| t.tab_id == id)
            .then_some(())
            .ok_or(Error::PaletteTabRemoved),
        NavigationTarget::Pane(id) => snapshot
            .panes
            .iter()
            .any(|p| p.pane_id == id)
            .then_some(())
            .ok_or(Error::PaletteDestinationRemoved),
    }
}

fn status_badge(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Blocked => "blocked",
        AgentStatus::Done => "done",
        AgentStatus::Working => "working",
        AgentStatus::Idle => "idle",
        AgentStatus::Unknown => "",
    }
}

/// One host's Go To rows: each workspace, its tabs when it has a choice of
/// them, then every pane, one row per agent or terminal so no split is hidden
/// behind its tab.
pub(super) fn go_to_entries(
    endpoint: &str,
    host: Option<&str>,
    snapshot: &ClientShellSnapshot,
    entries: &mut Vec<Entry>,
) {
    let go = |target| Action::Go {
        endpoint: endpoint.to_owned(),
        boot: snapshot.boot_id.clone(),
        target,
    };
    for workspace in &snapshot.workspaces {
        let detail = [
            host,
            Some(&*format!("#{}", workspace.number)),
            workspace.branch.as_deref(),
            projects::launch_root(snapshot, &workspace.workspace_id),
        ]
        .into_iter()
        .flatten()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("  ");
        let workspace_row = entries.len();
        entries.push(Entry::new(
            workspace.label.clone(),
            detail,
            "Workspace",
            go(NavigationTarget::Workspace(workspace.workspace_id.clone())),
            None,
        ));
        let tabs: Vec<_> = snapshot
            .tabs
            .iter()
            .filter(|tab| tab.workspace_id == workspace.workspace_id)
            .collect();
        for tab in &tabs {
            // As in the sidebar, a tab only earns its place when there is a choice.
            let tab_row = (tabs.len() > 1 || tab.custom_label).then(|| {
                let number = format!("#{}", tab.number);
                let detail = [host, Some(workspace.label.as_str()), Some(&number)]
                    .into_iter()
                    .flatten()
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("  ");
                entries.push(Entry::new(
                    tab.label.clone(),
                    detail,
                    "Tab",
                    go(NavigationTarget::Tab(tab.tab_id.clone())),
                    Some(workspace_row),
                ));
                entries.len() - 1
            });
            let parent = Some(tab_row.unwrap_or(workspace_row));
            let tab_id = &tab.tab_id;
            let tab = tab_row.map(|_| tab.label.as_str());
            let panes = snapshot.panes.iter().filter(|pane| {
                pane.workspace_id == workspace.workspace_id && pane.tab_id == *tab_id
            });
            for pane in panes {
                let agent = snapshot
                    .agents
                    .iter()
                    .find(|agent| agent.pane_id == pane.pane_id);
                let name = match agent {
                    Some(agent) => crate::sidebar::agent_name(agent),
                    None => pane
                        .label
                        .as_deref()
                        .map(str::trim)
                        .filter(|label| !label.is_empty())
                        .unwrap_or("Terminal"),
                };
                let path = pane.foreground_cwd.as_deref().or(pane.cwd.as_deref());
                let detail = [host, Some(workspace.label.as_str()), tab, path]
                    .into_iter()
                    .flatten()
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("  ");
                // An agent is also found by its kind, name, and plain status word,
                // whatever its row is titled or its integration labels the state.
                let keywords = agent.map_or(String::new(), |agent| {
                    [
                        agent.agent.as_deref(),
                        agent.name.as_deref(),
                        Some(status_badge(agent.agent_status)),
                        Some("agent"),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" ")
                });
                entries.push(Entry::with_keywords(
                    name.to_owned(),
                    detail,
                    agent.map_or(SharedString::new_static("Terminal"), |agent| {
                        crate::sidebar::state_label(agent, status_badge(agent.agent_status))
                            .into_owned()
                            .into()
                    }),
                    go(NavigationTarget::Pane(pane.pane_id.clone())),
                    parent,
                    &keywords,
                ));
            }
        }
    }
}

/// A row for each open workspace whose checkout has a note, most recently
/// edited note first, titled by the workspace and detailed by the note so a
/// search finds either. A note on a checkout no host has open has nowhere to
/// go, so it is left out.
pub(super) fn note_entries(
    notes: &crate::worktree_notes::Notes,
    sources: &[Source],
    endpoints: &[crate::endpoint::Endpoint],
    entries: &mut Vec<Entry>,
) {
    for note in notes.recent() {
        let checkout = &note.checkout;
        let Some(snapshot) = sources
            .iter()
            .find(|source| source.endpoint == checkout.endpoint && source.enabled)
            .and_then(|source| source.snapshot.as_ref())
        else {
            continue;
        };
        let host = (endpoints.len() > 1)
            .then(|| endpoints.iter().find(|e| e.id == checkout.endpoint))
            .flatten()
            .map(|endpoint| endpoint.label.as_str());
        for workspace in snapshot.workspaces.iter().filter(|w| {
            w.branch.as_deref() == Some(checkout.branch.as_str())
                && w.worktree
                    .as_ref()
                    .is_some_and(|tree| tree.key == checkout.repo_key)
        }) {
            let detail = [host, Some(note.text.as_str())]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("  ");
            entries.push(Entry::with_keywords(
                workspace.label.clone(),
                detail,
                "Note",
                Action::Note {
                    endpoint: checkout.endpoint.clone(),
                    boot: snapshot.boot_id.clone(),
                    workspace: workspace.workspace_id.clone(),
                },
                None,
                &checkout.branch,
            ));
        }
    }
}
