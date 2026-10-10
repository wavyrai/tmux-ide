//! The three blocking phases of a teleport, each run on a background worker:
//! find destinations, review what will move, and move it.

use super::{
    credentials,
    error::{Error, Result, Step},
    git,
    host::Host,
    launch::{Work, command_line, handoff_prompt, handoff_resume_prompt, remap, remap_argv},
    provision::{self, Arrival},
    remote::MatchReason,
    sessions::{Route, move_session},
    snapshot::{
        PaneInfoResult, SnapshotResult, TabCreated, TabList, WorkspaceCreated, WorktreeCreated,
    },
};
use herdr_client::{protocol::ClientShellSnapshot, shell_quote};
use std::{collections::HashMap, io::Seek, sync::atomic::AtomicBool, time::Duration};

mod discover;
mod plan;

// Only the live tests read a host's repositories outside discovery.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
pub(crate) use discover::repositories_of;
pub(crate) use discover::resolve;
pub(crate) use plan::{Action, GitHubAccess, PanePlan, Review, review};

/// How long an agent may take to write its handoff note.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(300);

/// An endpoint as Teleport addresses it.
#[derive(Debug, Clone)]
pub(crate) struct Place {
    pub(crate) endpoint_id: String,
    pub(crate) label: String,
    pub(crate) host: Host,
}

/// The workspace being moved, as the GUI snapshot describes it.
#[derive(Debug, Clone)]
pub(crate) struct Source {
    pub(crate) place: Place,
    pub(crate) workspace_id: String,
    /// A label the user chose, carried to the destination workspace.
    pub(crate) custom_label: Option<String>,
    pub(crate) repo_key: String,
    pub(crate) repo_label: String,
    /// The branch the GUI snapshot shows, for finding a checkout it left.
    pub(crate) branch: Option<String>,
    /// Tab labels the user chose, by source tab id.
    pub(crate) tab_labels: HashMap<String, String>,
}

/// A repository open on some host, found through one of its workspaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Repository {
    pub(crate) key: String,
    pub(crate) label: String,
    /// A workspace of the repository, preferably its main checkout.
    pub(crate) workspace_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HostRepositories {
    pub(crate) place: Place,
    /// The host's open repositories from its GUI snapshot, or `None` when it
    /// is not connected and they must be read through its CLI.
    pub(crate) repositories: Option<Vec<Repository>>,
    /// Checkouts on this host this client marked as teleported away.
    pub(crate) retired: Vec<Retired>,
}

/// A checkout whose work was teleported away, still open as a workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Retired {
    pub(crate) repo_key: String,
    pub(crate) branch: String,
    pub(crate) workspace_id: String,
}

/// Where the worktree lands on a host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Destination {
    /// The repository is open there already.
    Open {
        repository: Repository,
        reason: MatchReason,
    },
    /// It is not open: open an existing checkout or clone one first.
    Arrive(Arrival),
    /// The work left this checkout earlier and is coming back to it.
    Reclaim {
        repository: Repository,
        workspace_id: String,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub(crate) place: Place,
    pub(crate) destination: Destination,
    /// `origin`'s URL, for a clone the destination can fetch itself.
    pub(crate) origin: Option<String>,
}

/// Where the teleported workspace ended up.
#[derive(Debug, Clone)]
pub(crate) struct Outcome {
    pub(crate) endpoint_id: String,
    pub(crate) workspace_id: String,
    /// The destination repository, for remembering where the work went.
    pub(crate) repo_key: String,
    pub(crate) branch: String,
    /// Things that did not carry over, for the user to see.
    pub(crate) warnings: Vec<String>,
}

/// The repositories open in `snapshot`, one per Git common directory, each
/// reached through its main checkout's workspace when that is open.
pub(crate) fn open_repositories(snapshot: &ClientShellSnapshot) -> Vec<Repository> {
    let mut found: Vec<Repository> = Vec::new();
    for workspace in &snapshot.workspaces {
        let Some(tree) = &workspace.worktree else {
            continue;
        };
        match found.iter_mut().find(|repo| repo.key == tree.key) {
            Some(repo) if !tree.is_linked_worktree => {
                repo.workspace_id.clone_from(&workspace.workspace_id);
            }
            Some(_) => {}
            None => found.push(Repository {
                key: tree.key.clone(),
                label: tree.label.clone(),
                workspace_id: workspace.workspace_id.clone(),
            }),
        }
    }
    found
}

pub(super) fn reference_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("refs/herdr-teleport/{nanos:x}-{:x}", std::process::id())
}

/// Move the workspace. `report` announces each step as it starts.
pub(crate) fn run(
    source: &Source,
    destination: &Candidate,
    review: &Review,
    mut report: impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<Outcome> {
    let from = &source.place.host;
    let to = &destination.place.host;
    let mut warnings = Vec::new();

    // The repository comes first: if it cannot be put on the destination,
    // nothing on the source has been touched.
    let repository = arrive(source, destination, &mut report, cancelled)?;
    let key = &repository.key;

    // Notes are written into the source checkout first, so they travel with
    // the uncommitted changes.
    let handoffs: Vec<&PanePlan> = review
        .panes()
        .filter(|pane| matches!(pane.action, Action::Handoff { .. }))
        .collect();
    if !handoffs.is_empty() {
        report(Step::Handoff);
        let timeout = HANDOFF_TIMEOUT.as_millis().to_string();
        for pane in handoffs {
            let Action::Handoff { note, .. } = &pane.action else {
                continue;
            };
            let asked = from.herdr_ok(
                Step::Handoff,
                &[
                    "agent",
                    "prompt",
                    &pane.pane_id,
                    &handoff_prompt(&format!("{}/{note}", review.checkout)),
                    "--wait",
                    "--timeout",
                    &timeout,
                ],
                cancelled,
            );
            match asked {
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(error) => {
                    warnings.push(format!("No handoff note from {}: {error}", pane.pane_id))
                }
                Ok(()) => {}
            }
        }
    }

    report(Step::Capture);
    let dest = git::destination_branch(to, key, &review.branch, cancelled)?;
    // Coming back, the branch is checked out in the very checkout being
    // reclaimed, which is backed up rather than refused.
    if !matches!(destination.destination, Destination::Reclaim { .. }) {
        git::check_destination(from, &review.checkout, &review.branch, &dest, cancelled)?;
    }
    let reference = reference_name();
    let mut bundle = tempfile::tempfile().map_err(Error::LocalFile)?;
    git::capture(
        from,
        &review.checkout,
        &reference,
        &dest.tips,
        &mut bundle,
        cancelled,
    )?;
    bundle.rewind().map_err(Error::LocalFile)?;

    report(Step::Transfer);
    let uploaded = git::upload(to, bundle, cancelled)?;
    report(Step::Fetch);
    let fetched = git::fetch(to, key, &uploaded, &reference, cancelled);
    let _ = git::discard_upload(to, &uploaded, cancelled);
    fetched?;

    let placed = (|| {
        let landing = land(
            source,
            destination,
            &repository,
            review,
            &reference,
            &mut report,
            cancelled,
        )?;
        let panes = rebuild_tabs(to, &landing, review, &mut report, cancelled)?;
        Ok((landing, panes))
    })();
    let (landing, panes) = match placed {
        Ok(placed) => placed,
        Err(error) => {
            git::drop_reference(to, key, &reference, &AtomicBool::new(false));
            return Err(error);
        }
    };

    // The source's programs stop here, so every session file is complete. The
    // workspace itself stays, for this client to mark as teleported.
    report(Step::Retire);
    retire(from, &source.workspace_id, &review.checkout, cancelled)?;

    report(Step::Sessions);
    let mut launches = Vec::new();
    for (plan, target) in review.panes().zip(&panes) {
        let line = match &plan.action {
            Action::Shell | Action::Missing(_) => None,
            Action::Resume(agent) => {
                let Work::Session { session, flags, .. } = &plan.work else {
                    continue;
                };
                let route = Route {
                    source: from,
                    destination: to,
                    from: &review.checkout,
                    to: &landing.checkout,
                    cwd: &target.cwd,
                };
                Some(match move_session(*agent, session, &route, cancelled) {
                    Ok(reference) => agent.resume_argv(&reference, flags),
                    Err(Error::Cancelled) => return Err(Error::Cancelled),
                    Err(error) => {
                        warnings.push(format!("{} started afresh: {error}", agent.binary()));
                        agent.start_argv(None)
                    }
                })
            }
            Action::Handoff { note, to: agent } => {
                let note = format!("{}/{note}", landing.checkout);
                Some(agent.start_argv(Some(&handoff_resume_prompt(&note))))
            }
            Action::Start(argv) | Action::Run(argv) => {
                Some(remap_argv(argv, &review.checkout, &landing.checkout))
            }
        };
        if let Action::Missing(program) = &plan.action {
            warnings.push(format!(
                "{program} is not installed on {}",
                destination.place.label
            ));
        }
        if let Some(argv) = line {
            launches.push((target, argv));
        }
    }

    if review.github == GitHubAccess::Token {
        report(Step::Credentials);
        // Pull and push matter, but not more than the move: failures warn.
        let installed = credentials::local_token(cancelled).and_then(|token| {
            let token = token.ok_or(Error::InvalidToken)?;
            credentials::install(to, &landing.checkout, &token, cancelled)
        });
        match installed {
            Ok(credentials::Installed::Complete) => {}
            Ok(credentials::Installed::WithoutEnvrc) => warnings.push(
                "The repository tracks .envrc, so GH_TOKEN was not added; git pull and push still work"
                    .to_owned(),
            ),
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(error) => warnings.push(format!("GitHub access was not set up: {error}")),
        }
    }

    report(Step::Launch);
    for (target, argv) in launches {
        let mut line = command_line(&argv);
        if target.cwd != target.created_in {
            line = format!("cd -- {} && {line}", shell_quote(&target.cwd));
        }
        to.herdr_ok(
            Step::Launch,
            &["pane", "run", &target.pane_id, &line],
            cancelled,
        )?;
    }

    Ok(Outcome {
        endpoint_id: destination.place.endpoint_id.clone(),
        workspace_id: landing.workspace_id,
        repo_key: repository.key.clone(),
        branch: review.branch.clone(),
        warnings,
    })
}

/// The destination repository, opened as a space: as it is when already
/// open, else after opening an existing checkout or cloning one.
pub(super) fn arrive(
    source: &Source,
    destination: &Candidate,
    report: &mut impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<Repository> {
    let to = &destination.place.host;
    let (path, key) = match &destination.destination {
        Destination::Open { repository, .. } | Destination::Reclaim { repository, .. } => {
            return Ok(repository.clone());
        }
        Destination::Arrive(Arrival::Existing { path, key }) => (path, key.clone()),
        Destination::Arrive(Arrival::Clone { path }) => {
            report(Step::Clone);
            let key = provision::clone(
                &source.place.host,
                &source.repo_key,
                to,
                path,
                destination.origin.as_deref(),
                cancelled,
            )?;
            (path, key)
        }
    };
    report(Step::Open);
    let opened: WorkspaceCreated = to.herdr(
        Step::Open,
        &["workspace", "create", "--cwd", path, "--no-focus"],
        cancelled,
    )?;
    Ok(Repository {
        key,
        label: source.repo_label.clone(),
        workspace_id: opened.workspace.workspace_id,
    })
}

/// A new workspace on the destination repository's main checkout, cloning
/// the repository first where it is missing.
pub(super) fn open_workspace(
    source: &Source,
    destination: &Candidate,
    label: Option<&str>,
    report: &mut impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<String> {
    let to = &destination.place.host;
    let path = match &destination.destination {
        Destination::Open { repository, .. } | Destination::Reclaim { repository, .. } => {
            git::main_checkout(to, &repository.key, cancelled)?
        }
        Destination::Arrive(Arrival::Existing { path, .. }) => path.clone(),
        Destination::Arrive(Arrival::Clone { path }) => {
            report(Step::Clone);
            provision::clone(
                &source.place.host,
                &source.repo_key,
                to,
                path,
                destination.origin.as_deref(),
                cancelled,
            )?;
            path.clone()
        }
    };
    report(Step::Open);
    let mut args = vec!["workspace", "create", "--cwd", &path, "--no-focus"];
    if let Some(label) = label {
        args.extend(["--label", label]);
    }
    let opened: WorkspaceCreated = to.herdr(Step::Open, &args, cancelled)?;
    Ok(opened.workspace.workspace_id)
}

/// A destination pane standing in for a source pane.
#[derive(Debug, Clone)]
struct Target {
    pane_id: String,
    /// Where its program should run, and where its shell started.
    cwd: String,
    created_in: String,
}

/// Where the work lands: a workspace, its checkout, the empty tab the first
/// source tab is rebuilt in, and tabs to close once the rebuild is done.
struct Landing {
    workspace_id: String,
    checkout: String,
    first_tab: String,
    first_pane: String,
    stale_tabs: Vec<String>,
}

/// Put the branch and changes in place: a new worktree, or, coming back, the
/// checkout the work once left (backed up first).
fn land(
    source: &Source,
    destination: &Candidate,
    repository: &Repository,
    review: &Review,
    reference: &str,
    report: &mut impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<Landing> {
    let to = &destination.place.host;
    if let Destination::Reclaim { workspace_id, .. } = &destination.destination {
        report(Step::Restore);
        let snapshot: SnapshotResult = to.herdr(Step::Restore, &["api", "snapshot"], cancelled)?;
        let snapshot = snapshot.snapshot;
        let checkout = snapshot
            .workspace(workspace_id)
            .and_then(|workspace| workspace.worktree.as_ref())
            .map(|worktree| worktree.checkout_path.clone())
            .ok_or(Error::WorkspaceGone)?;
        let stale_tabs = snapshot
            .tabs_of(workspace_id)
            .iter()
            .map(|tab| tab.tab_id.clone())
            .collect();
        let backup = reference.replacen("refs/herdr-teleport/", "refs/herdr-teleport/backup/", 1);
        git::reclaim(to, &checkout, reference, &backup, cancelled)?;
        report(Step::Tabs);
        let made: TabCreated = to.herdr(
            Step::Tabs,
            &[
                "tab",
                "create",
                "--workspace",
                workspace_id,
                "--cwd",
                &checkout,
                "--no-focus",
            ],
            cancelled,
        )?;
        return Ok(Landing {
            workspace_id: workspace_id.clone(),
            checkout,
            first_tab: made.tab.tab_id,
            first_pane: made.root_pane.pane_id,
            stale_tabs,
        });
    }
    git::advance_branch(to, &repository.key, &review.branch, reference, cancelled)?;
    report(Step::CreateWorktree);
    let mut args = vec![
        "worktree",
        "create",
        "--workspace",
        &repository.workspace_id,
        "--branch",
        &review.branch,
        "--no-focus",
    ];
    if let Some(label) = &source.custom_label {
        args.extend(["--label", label]);
    }
    let created: WorktreeCreated = to.herdr(Step::CreateWorktree, &args, cancelled)?;
    report(Step::Restore);
    git::restore(to, &created.worktree.path, reference, cancelled)?;
    Ok(Landing {
        workspace_id: created.workspace.workspace_id,
        checkout: created.worktree.path,
        first_tab: created.tab.tab_id,
        first_pane: created.root_pane.pane_id,
        stale_tabs: Vec::new(),
    })
}

/// Stop everything running in the source workspace but keep the workspace:
/// one fresh shell tab replaces its tabs.
fn retire(host: &Host, workspace_id: &str, checkout: &str, cancelled: &AtomicBool) -> Result<()> {
    let tabs: TabList = host.herdr(
        Step::Retire,
        &["tab", "list", "--workspace", workspace_id],
        cancelled,
    )?;
    host.herdr_ok(
        Step::Retire,
        &[
            "tab",
            "create",
            "--workspace",
            workspace_id,
            "--cwd",
            checkout,
            "--label",
            "teleported",
            "--no-focus",
        ],
        cancelled,
    )?;
    for tab in tabs.tabs {
        host.herdr_ok(Step::Retire, &["tab", "close", &tab.tab_id], cancelled)?;
    }
    Ok(())
}

/// Rebuild the source tabs in `landing`, then close the tabs it replaces.
/// Returns one target per pane in `review.panes()` order.
fn rebuild_tabs(
    to: &Host,
    landing: &Landing,
    review: &Review,
    report: &mut impl FnMut(Step),
    cancelled: &AtomicBool,
) -> Result<Vec<Target>> {
    report(Step::Tabs);
    let checkout = &landing.checkout;
    let cwd_of = |plan: Option<&PanePlan>| {
        plan.and_then(|plan| plan.cwd.as_deref())
            .and_then(|cwd| remap(cwd, &review.checkout, checkout))
            .unwrap_or_else(|| checkout.clone())
    };
    let mut targets: HashMap<String, Target> = HashMap::new();
    for (index, tab) in review.tabs.iter().enumerate() {
        let build = tab.tree.plan();
        let first_cwd = cwd_of(build.slots.first().and_then(|id| tab.pane(id)));
        let (tab_id, root, root_cwd) = if index == 0 {
            (
                landing.first_tab.clone(),
                landing.first_pane.clone(),
                checkout.clone(),
            )
        } else {
            let made: TabCreated = to.herdr(
                Step::Tabs,
                &[
                    "tab",
                    "create",
                    "--workspace",
                    &landing.workspace_id,
                    "--cwd",
                    &first_cwd,
                    "--no-focus",
                ],
                cancelled,
            )?;
            (made.tab.tab_id, made.root_pane.pane_id, first_cwd.clone())
        };
        if let Some(label) = &tab.label {
            to.herdr_ok(Step::Tabs, &["tab", "rename", &tab_id, label], cancelled)?;
        }
        let mut slots = vec![(root, root_cwd)];
        for step in &build.steps {
            let cwd = cwd_of(build.slots.get(step.created).and_then(|id| tab.pane(id)));
            let ratio = format!("{:.4}", step.ratio);
            let target = &slots[step.target].0;
            let made: PaneInfoResult = to.herdr(
                Step::Tabs,
                &[
                    "pane",
                    "split",
                    target,
                    "--direction",
                    step.direction.as_str(),
                    "--ratio",
                    &ratio,
                    "--cwd",
                    &cwd,
                    "--no-focus",
                ],
                cancelled,
            )?;
            slots.push((made.pane.pane_id, cwd));
        }
        for (source_pane, (pane_id, created_in)) in build.slots.iter().zip(slots) {
            targets.insert(
                source_pane.clone(),
                Target {
                    pane_id,
                    cwd: cwd_of(tab.pane(source_pane)),
                    created_in,
                },
            );
        }
    }
    for tab in &landing.stale_tabs {
        to.herdr_ok(Step::Tabs, &["tab", "close", tab], cancelled)?;
    }
    review
        .panes()
        .map(|plan| {
            targets
                .get(&plan.pane_id)
                .cloned()
                .ok_or_else(|| Error::Decode {
                    step: Step::Tabs,
                    source: serde::de::Error::custom("a pane was not recreated"),
                })
        })
        .collect()
}
