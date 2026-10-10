//! Which workspaces the tree shows and how each one is named. A repository and
//! its linked worktrees form one group, folded or unfolded locally: collapsing
//! changes this client's view only, never the daemon's state.
//!
//! Grouping follows the TUI: every checkout that is not a linked worktree is a
//! parent, never another parent's child, and a repository only forms a group
//! once it has both a parent and at least one linked worktree open. Membership
//! comes from the daemon alone, so a checkout the daemon restored while it was
//! unavailable keeps its group.

use super::{
    RowBadge,
    agents::status_priority,
    row::{PrBadge, first_text},
};
use crate::config::Theme;
use herdr_client::protocol::{AgentStatus, ClientShellWorkspace};
use std::collections::{HashMap, HashSet};

/// The repositories that form a group: those with at least one parent and at
/// least one linked worktree among `workspaces`.
pub(super) fn grouped_keys(workspaces: &[ClientShellWorkspace]) -> HashSet<&str> {
    let mut kinds = HashMap::<&str, (bool, bool)>::new();
    for tree in workspaces.iter().filter_map(|w| w.worktree.as_ref()) {
        let (parent, linked) = kinds.entry(&tree.key).or_default();
        *parent |= !tree.is_linked_worktree;
        *linked |= tree.is_linked_worktree;
    }
    kinds
        .into_iter()
        .filter(|&(_, (parent, linked))| parent && linked)
        .map(|(key, _)| key)
        .collect()
}

/// Display order as `(index, child)`. A group shows where its earliest member
/// sits: all its parents first, in daemon order, then its linked worktrees.
pub(super) fn workspace_entries(workspaces: &[ClientShellWorkspace]) -> Vec<(usize, bool)> {
    let grouped = grouped_keys(workspaces);
    let mut members = HashMap::<&str, (Vec<usize>, Vec<usize>)>::new();
    for (index, workspace) in workspaces.iter().enumerate() {
        if let Some(tree) = workspace
            .worktree
            .as_ref()
            .filter(|tree| grouped.contains(tree.key.as_str()))
        {
            let (parents, children) = members.entry(&tree.key).or_default();
            if tree.is_linked_worktree {
                children.push(index);
            } else {
                parents.push(index);
            }
        }
    }
    let mut entries = Vec::with_capacity(workspaces.len());
    for (index, workspace) in workspaces.iter().enumerate() {
        let Some(tree) = workspace.worktree.as_ref() else {
            entries.push((index, false));
            continue;
        };
        if !grouped.contains(tree.key.as_str()) {
            entries.push((index, false));
            continue;
        }
        // Emitted once, at the group's earliest member; later members skip.
        if let Some((parents, children)) = members.remove(tree.key.as_str()) {
            entries.extend(parents.into_iter().map(|i| (i, false)));
            entries.extend(children.into_iter().map(|i| (i, true)));
        }
    }
    entries
}

/// Visible rows as `(index, child, group)`: `group` names the repository a
/// parent row folds, on every parent of a group.
pub(super) fn visible_workspace_entries(
    workspaces: &[ClientShellWorkspace],
    collapsed: &HashSet<String>,
) -> Vec<(usize, bool, Option<String>)> {
    let grouped = grouped_keys(workspaces);
    workspace_entries(workspaces)
        .into_iter()
        .filter_map(|(index, child)| {
            let key = workspaces[index]
                .worktree
                .as_ref()
                .map(|tree| tree.key.as_str())
                .filter(|key| grouped.contains(key));
            if child && key.is_some_and(|key| collapsed.contains(key)) {
                return None;
            }
            let group = key.filter(|_| !child).map(str::to_owned);
            Some((index, child, group))
        })
        .collect()
}

/// Cached pull request, dirty, note, and teleported marks for a worktree row, if the prefetch and
/// the Git probe already have them. Rendering only reads: a missing entry
/// simply shows nothing, never a stale or guessed state.
/// `cache` is `None` for a row on a device other than the selected one: the
/// cache holds only that device's lookups, and the same path and branch can
/// exist on another host.
pub(super) fn workspace_badge(
    workspace: &ClientShellWorkspace,
    cache: Option<&crate::pull_request::Cache>,
    git: &crate::git::Git,
    marks: (&crate::teleport::Marks, &str),
    note: Option<&str>,
    theme: &Theme,
) -> Option<RowBadge> {
    let key = workspace.worktree.as_ref()?.key.as_str();
    let branch = workspace.branch.as_deref()?;
    let (marks, endpoint) = marks;
    RowBadge::new(
        cache
            .and_then(|cache| cache.peek(key, branch))
            .map(|pr| PrBadge::new(pr, theme)),
        git.dirty(key, branch).unwrap_or(false),
        marks.find(endpoint, key, branch).is_some(),
        note.is_some(),
    )
}

/// The note the user keeps on a workspace's checkout, if it has one.
pub(super) fn workspace_note<'a>(
    workspace: &ClientShellWorkspace,
    notes: Option<&'a crate::worktree_notes::Notes>,
    endpoint: &str,
) -> Option<&'a str> {
    notes?.get(
        endpoint,
        &workspace.worktree.as_ref()?.key,
        workspace.branch.as_deref()?,
    )
}

pub(crate) fn workspace_label(workspace: &ClientShellWorkspace, indented: bool) -> &str {
    let branch = (indented && !workspace.custom_label)
        .then_some(workspace.branch.as_deref())
        .flatten()
        .map(|branch| branch.strip_prefix("worktree/").unwrap_or(branch));
    first_text([branch, Some(&workspace.label)], "workspace")
}

/// Collapsed groups show their most urgent member's status.
pub(super) fn displayed_workspace_status(
    workspaces: &[ClientShellWorkspace],
    workspace: &ClientShellWorkspace,
    collapsed: &HashSet<String>,
) -> AgentStatus {
    let Some(worktree) = workspace
        .worktree
        .as_ref()
        .filter(|worktree| !worktree.is_linked_worktree)
    else {
        return workspace.agent_status;
    };
    if !collapsed.contains(&worktree.key) {
        return workspace.agent_status;
    }
    workspaces
        .iter()
        .filter(|candidate| {
            candidate
                .worktree
                .as_ref()
                .is_some_and(|candidate| candidate.key == worktree.key)
        })
        .map(|candidate| candidate.agent_status)
        .max_by_key(|status| status_priority(*status))
        .unwrap_or(workspace.agent_status)
}
