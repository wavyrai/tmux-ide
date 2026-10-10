//! The discovery phase: find where on a host the worktree lands, from the
//! checkout it once left to a fresh clone.
use super::{Candidate, Destination, HostRepositories, Repository, Source};
use crate::teleport::{
    error::{Error, Result, Step},
    git,
    provision::{self, Arrival},
    remote::{MatchReason, RepoIdentity},
    snapshot::{HostSnapshot, SnapshotResult},
};
use std::sync::atomic::AtomicBool;

impl Candidate {
    fn rank(&self) -> (u8, Option<MatchReason>) {
        match &self.destination {
            Destination::Reclaim { .. } => (0, None),
            Destination::Open { reason, .. } => (1, Some(*reason)),
            Destination::Arrive(Arrival::Existing { .. }) => (2, None),
            Destination::Arrive(Arrival::Clone { .. }) => (3, None),
        }
    }
}

/// One repository per Git common directory, reached through its main
/// checkout's workspace when that is open.
pub(crate) fn repositories_of(snapshot: &HostSnapshot) -> Vec<Repository> {
    let mut found: Vec<Repository> = Vec::new();
    for workspace in &snapshot.workspaces {
        let Some(tree) = &workspace.worktree else {
            continue;
        };
        match found.iter_mut().find(|repo| repo.key == tree.repo_key) {
            Some(repo) if !tree.is_linked_worktree => {
                repo.workspace_id.clone_from(&workspace.workspace_id);
            }
            Some(_) => {}
            None => found.push(Repository {
                key: tree.repo_key.clone(),
                label: tree.repo_name.clone(),
                workspace_id: workspace.workspace_id.clone(),
            }),
        }
    }
    found
}

/// Where the worktree goes on `host`: the checkout it once left, a matching
/// open repository, an existing checkout to open, or a place to clone to.
/// Only the chosen host is looked at, so picking a host is instant.
pub(crate) fn resolve(
    source: &Source,
    host: &HostRepositories,
    cancelled: &AtomicBool,
) -> Result<Candidate> {
    let own = git::remotes(
        &source.place.host,
        std::slice::from_ref(&source.repo_key),
        cancelled,
    )?;
    let identity = RepoIdentity {
        name: source.repo_label.clone(),
        remotes: own.get(&source.repo_key).cloned().unwrap_or_default(),
    };
    let origin = provision::source_repository(
        &source.place.host,
        &source.repo_key,
        &source.repo_label,
        cancelled,
    )?;
    let candidates = discover_host(
        host,
        &identity,
        &origin,
        source.branch.as_deref(),
        cancelled,
    )?;
    candidates
        .into_iter()
        .min_by_key(Candidate::rank)
        .ok_or(Error::WorkspaceGone)
}

fn discover_host(
    host: &HostRepositories,
    identity: &RepoIdentity,
    source: &provision::SourceRepository,
    branch: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<Vec<Candidate>> {
    let repositories = match &host.repositories {
        Some(repositories) => repositories.clone(),
        None => {
            let snapshot: SnapshotResult =
                host.place
                    .host
                    .herdr(Step::Discover, &["api", "snapshot"], cancelled)?;
            repositories_of(&snapshot.snapshot)
        }
    };
    let keys: Vec<_> = repositories.iter().map(|r| r.key.clone()).collect();
    let remotes = git::remotes(&host.place.host, &keys, cancelled)?;
    let candidate = |destination| Candidate {
        place: host.place.clone(),
        destination,
        origin: source.origin.clone(),
    };
    let open: Vec<Candidate> = repositories
        .into_iter()
        .filter_map(|repository| {
            let theirs = RepoIdentity {
                name: repository.label.clone(),
                remotes: remotes.get(&repository.key).cloned().unwrap_or_default(),
            };
            let reason = identity.matches(&theirs)?;
            // Chosen without asking, a name alone is not enough when there
            // are remotes to compare: that is likely another project.
            if reason == MatchReason::Name && !identity.remotes.is_empty() {
                return None;
            }
            Some(candidate(Destination::Open { repository, reason }))
        })
        .collect();
    // Going back to a checkout the work left: that checkout is the place.
    let back = branch.and_then(|branch| {
        host.retired.iter().find_map(|retired| {
            let repository = open
                .iter()
                .find_map(|candidate| match &candidate.destination {
                    Destination::Open { repository, .. } if repository.key == retired.repo_key => {
                        Some(repository.clone())
                    }
                    _ => None,
                })?;
            (retired.branch == branch).then(|| Destination::Reclaim {
                repository,
                workspace_id: retired.workspace_id.clone(),
            })
        })
    });
    if let Some(back) = back {
        return Ok(vec![candidate(back)]);
    }
    if !open.is_empty() {
        return Ok(open);
    }
    let arrival = provision::probe(&host.place.host, source, identity, cancelled)?;
    Ok(vec![candidate(Destination::Arrive(arrival))])
}
