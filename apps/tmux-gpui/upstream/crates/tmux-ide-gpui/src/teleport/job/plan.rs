//! The review phase: read the source workspace and the destination, and
//! decide what each pane becomes.
use super::{Candidate, Destination, Source};
use crate::teleport::{
    credentials,
    error::{Error, Result, Step},
    git,
    host::Host,
    launch::{AgentKind, Work, handoff_path},
    layout::{Node, tree},
    provision::Arrival,
    remote::MatchReason,
    snapshot::{HostSnapshot, ProcessInfo, ProcessInfoResult, SnapshotResult},
};
use herdr_client::shell_quote;
use std::{collections::HashMap, sync::atomic::AtomicBool};

/// What the destination pane will do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Action {
    /// An idle shell.
    Shell,
    /// Move the agent's session and resume it.
    Resume(AgentKind),
    /// Ask the source agent for a note, then start `to` with it.
    Handoff { note: String, to: AgentKind },
    /// Start the same program afresh.
    Start(Vec<String>),
    /// Run the same command again.
    Run(Vec<String>),
    /// Nothing on the destination can take this over.
    Missing(String),
}

#[derive(Debug, Clone)]
pub(crate) struct PanePlan {
    pub(crate) pane_id: String,
    /// The directory the source program runs in.
    pub(crate) cwd: Option<String>,
    pub(crate) work: Work,
    pub(crate) action: Action,
}

#[derive(Debug, Clone)]
pub(crate) struct TabPlan {
    pub(crate) label: Option<String>,
    pub(crate) tree: Node,
    pub(crate) panes: Vec<PanePlan>,
}

impl TabPlan {
    pub(super) fn pane(&self, id: &str) -> Option<&PanePlan> {
        self.panes.iter().find(|pane| pane.pane_id == id)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Review {
    pub(crate) checkout: String,
    pub(crate) branch: String,
    pub(crate) state: git::SourceState,
    pub(crate) tabs: Vec<TabPlan>,
    /// Why an open repository was chosen; `None` when it arrives fresh.
    pub(crate) reason: Option<MatchReason>,
    pub(crate) github: GitHubAccess,
}

/// Whether the destination can pull and push to GitHub by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitHubAccess {
    /// It reaches `origin` already, or `origin` is not on GitHub.
    Direct,
    /// It cannot: this machine's `gh` token is installed for the repository.
    Token,
    /// It cannot, and `gh` here is not signed in to lend a token.
    Unavailable,
}

impl Review {
    pub(crate) fn panes(&self) -> impl Iterator<Item = &PanePlan> {
        self.tabs.iter().flat_map(|tab| tab.panes.iter())
    }
}

fn process_infos(
    host: &Host,
    panes: &[String],
    cancelled: &AtomicBool,
) -> Result<HashMap<String, ProcessInfo>> {
    let body = panes
        .iter()
        .map(|pane| {
            format!(
                "printf '\\036%s\\n' {pane}\nherdr_cli pane process-info --pane {pane} 2>/dev/null || :\n",
                pane = shell_quote(pane)
            )
        })
        .collect::<String>();
    let output = host.query(Step::Review, &body, &[], cancelled)?;
    let output = String::from_utf8_lossy(&output);
    Ok(output
        .split('\u{1e}')
        .filter_map(|section| {
            let (pane, json) = section.split_once('\n')?;
            let info =
                serde_json::from_str::<crate::teleport::snapshot::Envelope<ProcessInfoResult>>(
                    json,
                )
                .ok()?
                .result
                .process_info;
            Some((pane.to_owned(), info))
        })
        .collect())
}

/// Choose what each pane becomes on a destination with `installed` programs.
fn plan_action(work: &Work, installed: &[String], note: impl FnOnce() -> String) -> Action {
    let has = |program: &str| installed.iter().any(|p| p == program);
    let fallback = || {
        AgentKind::FALLBACKS
            .into_iter()
            .find(|kind| has(kind.binary()))
    };
    match work {
        Work::Shell => Action::Shell,
        Work::Session { agent, .. } if has(agent.binary()) => Action::Resume(*agent),
        Work::Session { agent, .. } => fallback().map_or_else(
            || Action::Missing(agent.binary().to_owned()),
            |to| Action::Handoff { note: note(), to },
        ),
        Work::Agent { name, argv } => match AgentKind::parse(name) {
            Some(kind) if kind.takes_prompt() && has(kind.binary()) => Action::Handoff {
                note: note(),
                to: kind,
            },
            _ if work.program().is_some_and(has) => Action::Start(argv.clone()),
            _ => fallback().map_or_else(
                || Action::Missing(name.clone()),
                |to| Action::Handoff { note: note(), to },
            ),
        },
        Work::Command(argv) => Action::Run(argv.clone()),
    }
}

/// Read the source workspace and the destination, and decide what moves.
pub(crate) fn review(
    source: &Source,
    destination: &Candidate,
    cancelled: &AtomicBool,
) -> Result<Review> {
    let host = &source.place.host;
    let snapshot: SnapshotResult = host.herdr(Step::Review, &["api", "snapshot"], cancelled)?;
    let snapshot = snapshot.snapshot;
    let worktree = snapshot
        .workspace(&source.workspace_id)
        .and_then(|workspace| workspace.worktree.clone())
        .filter(|worktree| worktree.is_linked_worktree)
        .ok_or(Error::WorkspaceGone)?;
    let state = git::source_state(host, &worktree.checkout_path, cancelled)?;
    let branch = state.branch.clone().ok_or(Error::DetachedHead)?;
    // A fresh clone has no branch to collide with; anything already there does.
    let key = match &destination.destination {
        Destination::Open { repository, .. } => Some(repository.key.as_str()),
        Destination::Arrive(Arrival::Existing { key, .. }) => Some(key.as_str()),
        Destination::Arrive(Arrival::Clone { .. }) => None,
        // The checkout there is this branch's, and is backed up before reuse.
        Destination::Reclaim { .. } => None,
    };
    if let Some(key) = key {
        let dest = git::destination_branch(&destination.place.host, key, &branch, cancelled)?;
        git::check_destination(host, &worktree.checkout_path, &branch, &dest, cancelled)?;
    }

    let tabs = snapshot.tabs_of(&source.workspace_id);
    let pane_ids: Vec<String> = snapshot
        .panes
        .iter()
        .filter(|pane| tabs.iter().any(|tab| tab.tab_id == pane.tab_id))
        .map(|pane| pane.pane_id.clone())
        .collect();
    let processes = process_infos(host, &pane_ids, cancelled)?;
    let works: Vec<(String, Work, Option<String>)> = pane_ids
        .iter()
        .filter_map(|id| {
            let pane = snapshot.pane(id)?;
            let process = processes.get(id).cloned().unwrap_or_default();
            let cwd = process
                .foreground_job()
                .and_then(|job| job.cwd.clone())
                .or_else(|| pane.foreground_cwd.clone())
                .or_else(|| pane.cwd.clone());
            Some((id.clone(), Work::classify(pane, &process), cwd))
        })
        .collect();
    let mut programs: Vec<&str> = AgentKind::FALLBACKS.iter().map(|k| k.binary()).collect();
    programs.extend(works.iter().filter_map(|(_, work, _)| work.program()));
    programs.sort_unstable();
    programs.dedup();
    let installed = destination
        .place
        .host
        .installed(Step::Review, &programs, cancelled)?;

    let github = match destination
        .origin
        .as_deref()
        .filter(|origin| credentials::is_github(origin))
    {
        Some(origin) if !credentials::reachable(&destination.place.host, origin, cancelled)? => {
            if credentials::local_token(cancelled)?.is_some() {
                GitHubAccess::Token
            } else {
                GitHubAccess::Unavailable
            }
        }
        _ => GitHubAccess::Direct,
    };

    let mut notes = 0;
    let tabs = tabs
        .iter()
        .map(|tab| plan_tab(&snapshot, tab, source, &works, &installed, &mut notes))
        .collect();
    Ok(Review {
        checkout: worktree.checkout_path,
        branch,
        state,
        tabs,
        reason: match &destination.destination {
            Destination::Open { reason, .. } => Some(*reason),
            Destination::Arrive(_) | Destination::Reclaim { .. } => None,
        },
        github,
    })
}

fn plan_tab(
    snapshot: &HostSnapshot,
    tab: &crate::teleport::snapshot::Tab,
    source: &Source,
    works: &[(String, Work, Option<String>)],
    installed: &[String],
    notes: &mut usize,
) -> TabPlan {
    let members: Vec<String> = snapshot
        .panes
        .iter()
        .filter(|pane| pane.tab_id == tab.tab_id)
        .map(|pane| pane.pane_id.clone())
        .collect();
    let node = snapshot
        .layout(&tab.tab_id)
        .and_then(tree)
        .or_else(|| Node::row(&members))
        .unwrap_or_else(|| Node::Pane(String::new()));
    let panes = node
        .plan()
        .slots
        .into_iter()
        .filter_map(|id| {
            let (_, work, cwd) = works.iter().find(|(pane, ..)| *pane == id)?;
            let action = plan_action(work, installed, || {
                let path = handoff_path(*notes);
                *notes += 1;
                path
            });
            Some(PanePlan {
                pane_id: id,
                cwd: cwd.clone(),
                work: work.clone(),
                action,
            })
        })
        .collect();
    TabPlan {
        label: source.tab_labels.get(&tab.tab_id).cloned(),
        tree: node,
        panes,
    }
}

#[cfg(test)]
mod tests;
