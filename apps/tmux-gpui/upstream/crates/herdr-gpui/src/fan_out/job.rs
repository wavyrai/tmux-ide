//! The blocking work behind a fan-out. Every function here runs host scripts
//! and must only be called from a background worker, never the UI thread.

use super::{
    error::{Error, Result, Step, script},
    plan::{DiffStat, Lane, parse_stats, stats_script},
};
use crate::teleport::{
    self, AgentKind, Envelope, FreshOrigin, Host, HostRepositories, Prepared, WorktreeCreated,
};
use std::sync::atomic::{AtomicBool, Ordering};

/// How long `herdr agent start` may wait for each agent to be ready. Agents
/// starting side by side on one machine are slower than one alone.
const AGENT_START_TIMEOUT_MS: &str = "90000";

/// What a fan-out launches.
#[derive(Debug, Clone)]
pub(crate) struct Request {
    /// The repository lanes branch from, through its main checkout.
    pub(crate) origin: FreshOrigin,
    /// The ref every lane branches from, resolved once on the origin so
    /// every lane, on every host, starts from the same commit.
    pub(crate) base: String,
    pub(crate) prompt: String,
    pub(crate) lanes: Vec<Lane>,
    /// Where each lane runs, in lane order: `None` on the origin, else the
    /// other host, which is set up once before its first lane.
    pub(crate) hosts: Vec<Option<HostRepositories>>,
}

/// A lane's new worktree, and the host it is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Checkout {
    pub(crate) endpoint_id: String,
    pub(crate) host: Host,
    pub(crate) workspace_id: String,
    pub(crate) path: String,
    pub(crate) pane_id: String,
}

/// How far one lane has got.
#[derive(Debug)]
pub(crate) enum Progress {
    /// Its host is getting the repository and the base commit.
    SettingUp,
    CreatingWorktree,
    Created(Checkout),
    StartingAgent,
    Prompting,
    /// The agent took the prompt and is working on it.
    Running,
    Failed(Error),
}

#[derive(Debug)]
pub(crate) enum Report {
    /// The commit every lane branches from and is compared against.
    Base(String),
    Lane(usize, Progress),
}

/// Where lanes on one host are created through.
#[derive(Clone)]
struct Site {
    endpoint_id: String,
    label: String,
    host: Host,
    workspace_id: String,
    /// The agents installed on another host. The origin's were listed
    /// before anything was picked.
    agents: Option<Vec<AgentKind>>,
}

/// Another host set up for its lanes, whose shipped commit's reference is
/// dropped once every lane is created.
struct SetUp {
    endpoint_id: String,
    result: Option<(Site, Prepared)>,
}

/// Each lane's site, setting up every other host once: the repository and
/// the base commit put there. A host that cannot be set up fails its lanes,
/// the first with the cause. Returns the sites, `None` for a failed lane,
/// and the hosts set up.
fn sites(
    request: &Request,
    commit: &str,
    report: &impl Fn(Report),
    cancelled: &AtomicBool,
) -> (Vec<Option<Site>>, Vec<SetUp>) {
    let origin = &request.origin;
    let mut set_up: Vec<SetUp> = Vec::new();
    let mut sites = Vec::with_capacity(request.lanes.len());
    for (index, host) in request.hosts.iter().enumerate() {
        let Some(destination) = host else {
            sites.push(Some(Site {
                endpoint_id: origin.place.endpoint_id.clone(),
                label: origin.place.label.clone(),
                host: origin.place.host.clone(),
                workspace_id: origin.workspace_id.clone(),
                agents: None,
            }));
            continue;
        };
        let endpoint = &destination.place.endpoint_id;
        if let Some(known) = set_up.iter().find(|known| &known.endpoint_id == endpoint) {
            let site = known.result.as_ref().map(|(site, _)| site.clone());
            if site.is_none() {
                report(Report::Lane(
                    index,
                    Progress::Failed(Error::HostUnavailable {
                        host: destination.place.label.clone(),
                    }),
                ));
            }
            sites.push(site);
            continue;
        }
        report(Report::Lane(index, Progress::SettingUp));
        let result = match set_up_host(origin, destination, commit, cancelled) {
            Ok(result) => Some(result),
            Err(error) => {
                report(Report::Lane(index, Progress::Failed(error)));
                None
            }
        };
        sites.push(result.as_ref().map(|(site, _)| site.clone()));
        set_up.push(SetUp {
            endpoint_id: endpoint.clone(),
            result,
        });
    }
    (sites, set_up)
}

/// The repository and the base commit on `destination`, and the agents
/// installed there.
fn set_up_host(
    origin: &FreshOrigin,
    destination: &HostRepositories,
    commit: &str,
    cancelled: &AtomicBool,
) -> Result<(Site, Prepared)> {
    let host = &destination.place.host;
    let agents = installed(host, cancelled)?;
    let prepared = teleport::prepare(origin, destination, commit, &mut |_| {}, cancelled)
        .map_err(Error::Dispatch)?;
    let site = Site {
        endpoint_id: destination.place.endpoint_id.clone(),
        label: destination.place.label.clone(),
        host: host.clone(),
        workspace_id: prepared.repository.workspace_id.clone(),
        agents: Some(agents),
    };
    Ok((site, prepared))
}

/// Resolve the base commit, set up every host, then create every lane's
/// worktree one at a time, since concurrent `git worktree add` runs contend
/// for a repository's ref locks, and start the agents side by side.
pub(crate) fn launch(request: &Request, report: &(impl Fn(Report) + Sync), cancelled: &AtomicBool) {
    let commit = match teleport::base_commit(&request.origin, &request.base, cancelled) {
        Ok(commit) => commit,
        Err(error) => {
            report(Report::Lane(0, Progress::Failed(Error::Dispatch(error))));
            for index in 1..request.lanes.len() {
                report(Report::Lane(index, Progress::Failed(Error::NoBase)));
            }
            return;
        }
    };
    report(Report::Base(commit.clone()));
    let (sites, set_up) = sites(request, &commit, report, cancelled);
    let mut created = Vec::new();
    for (index, (lane, site)) in request.lanes.iter().zip(&sites).enumerate() {
        let Some(site) = site else {
            continue;
        };
        if cancelled.load(Ordering::Acquire) {
            report(Report::Lane(index, Progress::Failed(Error::Cancelled)));
            continue;
        }
        if site
            .agents
            .as_ref()
            .is_some_and(|agents| !agents.contains(&lane.kind))
        {
            report(Report::Lane(
                index,
                Progress::Failed(Error::AgentMissing {
                    agent: lane.kind.name(),
                    host: site.label.clone(),
                }),
            ));
            continue;
        }
        report(Report::Lane(index, Progress::CreatingWorktree));
        match create(site, lane, &commit, cancelled) {
            Ok(checkout) => {
                report(Report::Lane(index, Progress::Created(checkout.clone())));
                created.push((index, lane, checkout));
            }
            Err(error) => report(Report::Lane(index, Progress::Failed(error))),
        }
    }
    // The new branches keep the shipped commit; its references can go.
    for (_, prepared) in set_up.into_iter().filter_map(|set_up| set_up.result) {
        prepared.finish(&AtomicBool::new(false));
    }
    std::thread::scope(|scope| {
        for (index, lane, checkout) in &created {
            let run = move || {
                let progress = match start(request, *index, lane, checkout, report, cancelled) {
                    Ok(()) => Progress::Running,
                    Err(error) => Progress::Failed(error),
                };
                report(Report::Lane(*index, progress));
            };
            let spawned = std::thread::Builder::new()
                .name("herdr-fan-out-lane".into())
                .spawn_scoped(scope, run);
            if let Err(error) = spawned {
                tracing::warn!(%error, "could not start a fan-out lane worker");
                report(Report::Lane(
                    *index,
                    Progress::Failed(Error::Script {
                        step: Step::StartAgent,
                        source: herdr_client::Error::ScriptSpawn(error),
                    }),
                ));
            }
        }
    });
}

fn create(site: &Site, lane: &Lane, commit: &str, cancelled: &AtomicBool) -> Result<Checkout> {
    let line = Host::herdr_line(&[
        "worktree",
        "create",
        "--workspace",
        &site.workspace_id,
        "--branch",
        &lane.branch,
        "--base",
        commit,
        "--no-focus",
    ]);
    let output = site
        .host
        .capture(&line, cancelled)
        .map_err(script(Step::CreateWorktree))?;
    let created = serde_json::from_slice::<Envelope<WorktreeCreated>>(&output)
        .map_err(|source| Error::Decode {
            step: Step::CreateWorktree,
            source,
        })?
        .result;
    Ok(Checkout {
        endpoint_id: site.endpoint_id.clone(),
        host: site.host.clone(),
        workspace_id: created.workspace.workspace_id,
        path: created.worktree.path,
        pane_id: created.root_pane.pane_id,
    })
}

/// Start the lane's agent in its first pane and, once it is ready, send it
/// the prompt.
fn start(
    request: &Request,
    index: usize,
    lane: &Lane,
    checkout: &Checkout,
    report: &impl Fn(Report),
    cancelled: &AtomicBool,
) -> Result<()> {
    report(Report::Lane(index, Progress::StartingAgent));
    let start = Host::herdr_line(&[
        "agent",
        "start",
        &lane.agent,
        "--kind",
        lane.kind.name(),
        "--pane",
        &checkout.pane_id,
        "--timeout",
        AGENT_START_TIMEOUT_MS,
    ]);
    checkout
        .host
        .capture(&start, cancelled)
        .map_err(script(Step::StartAgent))?;
    report(Report::Lane(index, Progress::Prompting));
    // The pane is the target: an agent name could match one started elsewhere.
    let prompt = Host::herdr_line(&["agent", "prompt", &checkout.pane_id, &request.prompt]);
    checkout
        .host
        .capture(&prompt, cancelled)
        .map_err(script(Step::Prompt))?;
    Ok(())
}

/// The agent kinds installed on `host`, in [`AgentKind::ALL`] order.
pub(crate) fn installed(host: &Host, cancelled: &AtomicBool) -> Result<Vec<AgentKind>> {
    let binaries = AgentKind::ALL.map(AgentKind::binary);
    let found = host
        .installed_programs(&binaries, cancelled)
        .map_err(script(Step::Detect))?;
    Ok(AgentKind::ALL
        .into_iter()
        .filter(|kind| found.iter().any(|binary| binary == kind.binary()))
        .collect())
}

/// One host's part of a comparison: the lanes on it, and their changes
/// since the base, `None` for a checkout that is gone, in the same order.
#[derive(Debug)]
pub(crate) struct HostStats {
    pub(crate) lanes: Vec<usize>,
    pub(crate) result: Result<Vec<Option<DiffStat>>>,
}

/// Each lane's changes since `base`, reading every host once. A host that
/// cannot be read fails only its own lanes.
pub(crate) fn stats(
    checkouts: &[Option<(Host, String)>],
    base: &str,
    cancelled: &AtomicBool,
) -> Vec<HostStats> {
    let mut hosts: Vec<(&Host, Vec<usize>)> = Vec::new();
    for (index, (host, _)) in checkouts
        .iter()
        .enumerate()
        .filter_map(|(index, checkout)| Some((index, checkout.as_ref()?)))
    {
        match hosts.iter_mut().find(|(known, _)| *known == host) {
            Some((_, lanes)) => lanes.push(index),
            None => hosts.push((host, vec![index])),
        }
    }
    hosts
        .into_iter()
        .map(|(host, lanes)| {
            let paths: Vec<String> = lanes
                .iter()
                .filter_map(|&index| Some(checkouts[index].as_ref()?.1.clone()))
                .collect();
            let result = host
                .capture(&stats_script(&paths, base), cancelled)
                .map_err(script(Step::Compare))
                .map(|output| parse_stats(&String::from_utf8_lossy(&output), paths.len()));
            HostStats { lanes, result }
        })
        .collect()
}

/// Remove a lane's worktree and workspace, discarding uncommitted changes.
/// Herdr keeps the branch, so committed work stays reachable.
pub(crate) fn remove(host: &Host, workspace_id: &str, cancelled: &AtomicBool) -> Result<()> {
    let line = Host::herdr_line(&["worktree", "remove", "--workspace", workspace_id, "--force"]);
    host.capture(&line, cancelled)
        .map(drop)
        .map_err(script(Step::Remove))
}
