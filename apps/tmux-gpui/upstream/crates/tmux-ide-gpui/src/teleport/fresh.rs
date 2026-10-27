//! A fresh worktree on another host, for smart dispatch: nothing moves but
//! the base commit. The repository is found on the destination (or cloned
//! there, as Teleport does), the base commit is shipped when the destination
//! lacks it, and the destination's own daemon creates the worktree from it.

use super::{
    error::{Error, Result, Step},
    git,
    host::Host,
    job::{self, HostRepositories, Place, Repository, Source},
    snapshot::WorktreeCreated,
};
use std::{collections::HashMap, io::Seek, sync::atomic::AtomicBool};

/// The repository a dispatched worktree branches from, on its own host.
#[derive(Debug, Clone)]
pub(crate) struct Origin {
    pub(crate) place: Place,
    /// A workspace of the repository, preferably its main checkout.
    pub(crate) workspace_id: String,
    /// The repository's Git common directory on the origin host.
    pub(crate) repo_key: String,
    pub(crate) repo_label: String,
}

impl Origin {
    fn source(&self) -> Source {
        Source {
            place: self.place.clone(),
            workspace_id: self.workspace_id.clone(),
            custom_label: None,
            repo_key: self.repo_key.clone(),
            repo_label: self.repo_label.clone(),
            // A fresh worktree never reclaims a checkout work once left.
            branch: None,
            tab_labels: HashMap::new(),
        }
    }
}

/// The commit `reference` names on the origin, so every destination
/// branches from the same commit however its own refs differ.
pub(crate) fn base_commit(
    origin: &Origin,
    reference: &str,
    cancelled: &AtomicBool,
) -> Result<String> {
    git::resolve_commit(&origin.place.host, &origin.repo_key, reference, cancelled)
}

/// The repository open on a destination with the base commit in it.
#[derive(Debug)]
pub(crate) struct Prepared {
    pub(crate) repository: Repository,
    host: Host,
    /// The shipped commit's temporary reference, dropped by [`Prepared::finish`].
    reference: Option<String>,
}

impl Prepared {
    /// Drop the shipped commit's temporary reference. The new branches keep
    /// the commit reachable.
    pub(crate) fn finish(&self, cancelled: &AtomicBool) {
        if let Some(reference) = &self.reference {
            git::drop_reference(&self.host, &self.repository.key, reference, cancelled);
        }
    }
}

/// Put the repository on `destination`, opened as a workspace, and make sure
/// it has `commit`.
pub(crate) fn prepare(
    origin: &Origin,
    destination: &HostRepositories,
    commit: &str,
    report: &mut impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<Prepared> {
    report(Step::Discover);
    let source = origin.source();
    let candidate = job::resolve(&source, destination, cancelled)?;
    let repository = job::arrive(&source, &candidate, report, cancelled)?;
    let to = &destination.place.host;
    let mut prepared = Prepared {
        repository,
        host: to.clone(),
        reference: None,
    };
    if git::has_commit(to, &prepared.repository.key, commit, cancelled)? {
        return Ok(prepared);
    }
    report(Step::Capture);
    let key = prepared.repository.key.clone();
    // The branch name only matters for Teleport; tips are what is needed.
    let tips = git::destination_branch(to, &key, "HEAD", cancelled)?.tips;
    let reference = job::reference_name();
    let mut bundle = tempfile::tempfile().map_err(Error::LocalFile)?;
    git::bundle_commit(
        &origin.place.host,
        &origin.repo_key,
        commit,
        &reference,
        &tips,
        &mut bundle,
        cancelled,
    )?;
    bundle.rewind().map_err(Error::LocalFile)?;
    report(Step::Transfer);
    let uploaded = git::upload(to, bundle, cancelled)?;
    report(Step::Fetch);
    let fetched = git::fetch(to, &key, &uploaded, &reference, cancelled);
    let _ = git::discard_upload(to, &uploaded, cancelled);
    fetched?;
    prepared.reference = Some(reference);
    Ok(prepared)
}

/// What the new worktree is called. Either may be left to the daemon.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Naming {
    pub(crate) branch: Option<String>,
    pub(crate) label: Option<String>,
}

/// Where a dispatched worktree or workspace was created.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Created {
    pub(crate) endpoint_id: String,
    pub(crate) workspace_id: String,
    /// A new worktree, for its setup script; a workspace has none.
    pub(crate) checkout: Option<NewCheckout>,
}

/// A worktree created on the destination, as its setup script needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewCheckout {
    /// The destination repository's Git common directory, which the user's
    /// trust in its script file is kept under.
    pub(crate) repo_key: String,
    pub(crate) path: String,
    /// The repository's main checkout there, when it could be read.
    pub(crate) root: Option<String>,
}

/// Create one worktree on `destination` from `commit`, through `prepared`'s
/// workspace.
fn create_worktree(
    prepared: &Prepared,
    commit: &str,
    naming: &Naming,
    report: &mut impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<WorktreeCreated> {
    report(Step::CreateWorktree);
    let mut args = vec![
        "worktree",
        "create",
        "--workspace",
        &prepared.repository.workspace_id,
        "--base",
        commit,
        "--no-focus",
    ];
    if let Some(branch) = &naming.branch {
        args.extend(["--branch", branch]);
    }
    if let Some(label) = &naming.label {
        args.extend(["--label", label]);
    }
    prepared.host.herdr(Step::CreateWorktree, &args, cancelled)
}

/// The whole of a dispatched new worktree: resolve the base on the origin,
/// prepare the destination, and create the worktree there.
pub(crate) fn dispatch_worktree(
    origin: &Origin,
    destination: &HostRepositories,
    base: &str,
    naming: &Naming,
    mut report: impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<Created> {
    let commit = base_commit(origin, base, cancelled)?;
    let prepared = prepare(origin, destination, &commit, &mut report, cancelled)?;
    let created = create_worktree(&prepared, &commit, naming, &mut report, cancelled);
    prepared.finish(&AtomicBool::new(false));
    let created = created?;
    let key = &prepared.repository.key;
    let root = git::main_checkout(&destination.place.host, key, cancelled).ok();
    Ok(Created {
        endpoint_id: destination.place.endpoint_id.clone(),
        workspace_id: created.workspace.workspace_id,
        checkout: Some(NewCheckout {
            repo_key: key.clone(),
            path: created.worktree.path,
            root,
        }),
    })
}

/// Open the repository on `destination` as a new workspace, for a new
/// workspace dispatched there. A repository already open there gets one
/// more workspace on its main checkout.
pub(crate) fn dispatch_workspace(
    origin: &Origin,
    destination: &HostRepositories,
    label: Option<&str>,
    mut report: impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<Created> {
    report(Step::Discover);
    let source = origin.source();
    let candidate = job::resolve(&source, destination, cancelled)?;
    let workspace_id = job::open_workspace(&source, &candidate, label, &mut report, cancelled)?;
    Ok(Created {
        endpoint_id: destination.place.endpoint_id.clone(),
        workspace_id,
        checkout: None,
    })
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
