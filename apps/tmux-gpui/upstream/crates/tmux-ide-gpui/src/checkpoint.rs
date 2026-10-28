//! Agent checkpoints: a snapshot of a checkout each time one of its agents
//! starts or finishes a turn, so the user can roll its files back to an
//! earlier point.
//!
//! Turns come from the daemon's agent status in each endpoint's snapshot,
//! never from terminal output. Git runs in the checkout's own host (this
//! machine or an SSH host) on one worker thread per host, so a slow host never
//! delays another and the UI thread only queues jobs and takes answers. Taking
//! a checkpoint never touches the checkout's index or files; restoring one is
//! an explicit, confirmed action that first checkpoints the current state.

mod script;
#[cfg(test)]
mod tests;

use crate::{Error, Result, usage::Host};
use herdr_client::{
    ConnectTarget, ScriptHost, ScriptLimits,
    protocol::{AgentStatus, ClientShellSnapshot},
    run_script,
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Weak, atomic::AtomicBool, mpsc},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Checkpoints kept per checkout; older ones are deleted as new ones arrive.
pub(crate) const KEEP: usize = 50;
/// Jobs waiting per host. Captures for one checkout merge, so this is only
/// reached by many checkouts finishing turns at once.
const QUEUE_LIMIT: usize = 32;
/// Hosts are few; an unbounded endpoint list still cannot start more workers.
const HOST_LIMIT: usize = 16;
/// Snapshotting a large checkout hashes every changed file, which can be
/// quiet for a while; output is a few lines per checkpoint.
const LIMITS: ScriptLimits = ScriptLimits {
    output: 1024 * 1024,
    idle: Duration::from_secs(120),
};

/// The host whose checkouts an endpoint's snapshot names, when this client
/// may run Git there: an SSH host, or this machine when the daemon is the
/// user's own (the trust boundary local Git status uses). Host scripts need a
/// POSIX client; see `herdr_client::run_script`.
pub(crate) fn host_for(target: &ConnectTarget, live: &crate::LiveState) -> Option<Host> {
    if !cfg!(any(target_os = "linux", target_os = "macos")) {
        return None;
    }
    match target {
        ConnectTarget::Ssh { target, .. } => Some(Host::Ssh(target.clone())),
        // No script runs inside a distribution yet, so its checkouts are not snapshotted.
        ConnectTarget::Wsl { .. } => None,
        ConnectTarget::Local | ConnectTarget::Session { .. } => {
            live.local_daemon_peer.then_some(Host::Local)
        }
        // A cloud machine is reached only through its provider's command, which host
        // scripts do not run over.
        ConnectTarget::Socket(_) => None,
        #[cfg(feature = "cloud")]
        ConnectTarget::Cloud { .. } => None,
    }
}

/// A checkout on a host, found by its repository and checked-out branch, as
/// the daemon's snapshot names them.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Checkout {
    pub host: Host,
    /// The repository's Git common directory on that host.
    pub repo_key: String,
    pub branch: String,
}

impl Checkout {
    /// The checkout a workspace shows, when it names one checkpoints can use.
    pub fn new(host: Host, repo_key: &str, branch: Option<&str>) -> Option<Self> {
        let branch = branch.filter(|branch| {
            !branch.is_empty() && branch.len() <= 1024 && !branch.chars().any(char::is_control)
        })?;
        // A remote host's paths are its own: check the form, not this disk.
        (repo_key.starts_with('/') && !repo_key.chars().any(char::is_control)).then(|| Self {
            host,
            repo_key: repo_key.to_owned(),
            branch: branch.to_owned(),
        })
    }
}

/// What a checkpoint changed since the one before it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Diff {
    pub files: u64,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Checkpoint {
    pub id: String,
    /// Unix seconds, on the host's clock.
    pub created: i64,
    pub label: String,
    /// The branch it was taken on; only that branch can be restored to it.
    pub branch: Option<String>,
    pub diff: Diff,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Request {
    Capture { label: String },
    List,
    Restore { id: String },
}

impl Request {
    /// The answer this request gets when it could not run at all.
    fn failed(&self, error: Error) -> Answer {
        match self {
            Self::Capture { .. } => Answer::Captured(Err(error)),
            Self::List => Answer::Listed(Err(error)),
            Self::Restore { .. } => Answer::Restored(Err(error)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Job {
    checkout: Checkout,
    request: Request,
}

enum Answer {
    Captured(Result<Option<String>>),
    Listed(Result<Vec<Checkpoint>>),
    Restored(Result<()>),
}

fn execute(job: &Job, stamp: &str) -> Answer {
    let checkout = &job.checkout;
    match &job.request {
        Request::Capture { label } => Answer::Captured(
            run(checkout, &script::capture(checkout, label, stamp, KEEP))
                .and_then(|output| script::parse_capture(&output)),
        ),
        Request::List => Answer::Listed(
            run(checkout, &script::list(checkout)).and_then(|output| script::parse_list(&output)),
        ),
        Request::Restore { id } => Answer::Restored(
            run(
                checkout,
                &script::restore(checkout, id, "Before restoring a checkpoint", stamp, KEEP),
            )
            .map(drop),
        ),
    }
}

/// Never cancelled: killing Git halfway through a snapshot or a restore could
/// leave a lock or a half-moved working tree behind; the idle limit ends it.
fn run(checkout: &Checkout, body: &str) -> Result<String> {
    let host = match &checkout.host {
        Host::Local => ScriptHost::Local,
        Host::Ssh(target) => ScriptHost::Ssh(target),
        Host::Wsl(_) => return Err(Error::WslHostUnsupported),
    };
    let mut output = Vec::new();
    run_script(
        host,
        body,
        std::io::empty(),
        &mut output,
        LIMITS,
        &AtomicBool::new(false),
    )
    .map_err(script::classify)?;
    Ok(String::from_utf8_lossy(&output).into_owned())
}

struct Worker {
    requests: mpsc::SyncSender<(Job, String)>,
    results: mpsc::Receiver<Answer>,
}

fn spawn() -> Result<Worker> {
    let (requests, incoming) = mpsc::sync_channel::<(Job, String)>(1);
    let (outgoing, results) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("herdr-checkpoints".into())
        .spawn(move || {
            for (job, stamp) in incoming {
                if outgoing.send(execute(&job, &stamp)).is_err() {
                    break;
                }
            }
        })
        .map_err(Error::CheckpointThread)?;
    Ok(Worker { requests, results })
}

/// One host's jobs, run one at a time in order.
#[derive(Default)]
struct Lane {
    worker: Option<Worker>,
    queue: VecDeque<Job>,
    running: Option<Job>,
}

/// What one endpoint's agents were doing in the last snapshot looked at.
#[derive(Default)]
struct Watch {
    snapshot: Weak<ClientShellSnapshot>,
    boot_id: String,
    statuses: HashMap<String, AgentStatus>,
}

/// What a checkpoint list shows while it loads or after it failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Listing {
    Loading,
    Ready(Vec<Checkpoint>),
    Failed(String),
}

/// The open checkpoints dialog: one checkout's list, and the restore the user
/// is confirming or running.
pub(crate) struct View {
    pub checkout: Checkout,
    pub title: String,
    /// The workspace it was opened from, whose agents a restore would race.
    pub workspace_id: String,
    pub listing: Listing,
    pub selected: Option<usize>,
    /// The checkpoint the user asked to restore, awaiting confirmation.
    pub confirming: Option<String>,
    pub restoring: bool,
    pub error: Option<String>,
}

impl View {
    pub fn selected_checkpoint(&self) -> Option<&Checkpoint> {
        match &self.listing {
            Listing::Ready(list) => list.get(self.selected?),
            _ => None,
        }
    }

    pub fn confirming_checkpoint(&self) -> Option<&Checkpoint> {
        let id = self.confirming.as_deref()?;
        match &self.listing {
            Listing::Ready(list) => list.iter().find(|checkpoint| checkpoint.id == id),
            _ => None,
        }
    }

    /// Whether `checkpoint` can be restored into the checkout as it is now.
    pub fn restorable(&self, checkpoint: &Checkpoint) -> bool {
        checkpoint.branch.as_deref() == Some(self.checkout.branch.as_str())
    }
}

/// A restore that finished, for the window to report even after its dialog
/// closed.
#[derive(Debug)]
pub(crate) struct Restored {
    pub checkout: Checkout,
    pub result: Result<()>,
}

#[derive(Default)]
pub(crate) struct Checkpoints {
    watches: HashMap<String, Watch>,
    lanes: HashMap<Host, Lane>,
    pub view: Option<View>,
    /// Last stamp handed out, so two checkpoints never share a name.
    last_stamp: u128,
}

/// The name an agent goes by in a checkpoint label.
fn agent_name(agent: &herdr_client::protocol::ClientShellAgent) -> &str {
    [&agent.display_agent, &agent.agent, &agent.name]
        .into_iter()
        .flatten()
        .map(|name| name.trim())
        .find(|name| !name.is_empty())
        .unwrap_or("Agent")
}

impl Checkpoints {
    /// Look at `endpoint`'s latest snapshot and queue a checkpoint of each
    /// checkout whose agent just started or finished a turn. A snapshot
    /// already looked at, the first one, and one from a restarted daemon
    /// only record statuses: no turn is seen across a gap.
    pub fn observe(&mut self, endpoint: &str, host: &Host, snapshot: &Arc<ClientShellSnapshot>) {
        let watch = self.watches.entry(endpoint.to_owned()).or_default();
        if std::ptr::eq(watch.snapshot.as_ptr(), Arc::as_ptr(snapshot)) {
            return;
        }
        watch.snapshot = Arc::downgrade(snapshot);
        let restarted = watch.boot_id != snapshot.boot_id;
        watch.boot_id.clone_from(&snapshot.boot_id);
        let previous = std::mem::take(&mut watch.statuses);
        let mut captures = Vec::new();
        for agent in &snapshot.agents {
            watch
                .statuses
                .insert(agent.pane_id.clone(), agent.agent_status);
            let Some(before) = previous.get(&agent.pane_id).filter(|_| !restarted) else {
                continue;
            };
            use AgentStatus::*;
            let label = match (before, agent.agent_status) {
                // A turn resuming after a permission prompt is the same turn.
                (Idle | Done, Working) => format!("Before {}'s turn", agent_name(agent)),
                (Working | Blocked, Idle | Done) => {
                    format!("{} finished a turn", agent_name(agent))
                }
                _ => continue,
            };
            let checkout = snapshot
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == agent.workspace_id)
                .and_then(|workspace| {
                    Checkout::new(
                        host.clone(),
                        &workspace.worktree.as_ref()?.key,
                        workspace.branch.as_deref(),
                    )
                });
            if let Some(checkout) = checkout {
                captures.push((checkout, label));
            }
        }
        for (checkout, label) in captures {
            self.capture(checkout, label);
        }
    }

    /// Forget endpoints no longer watched, so a reconnect starts afresh.
    pub fn retain_endpoints(&mut self, keep: impl Fn(&str) -> bool) {
        self.watches.retain(|endpoint, _| keep(endpoint));
    }

    fn lane(&mut self, host: &Host) -> Option<&mut Lane> {
        if !self.lanes.contains_key(host) && self.lanes.len() >= HOST_LIMIT {
            tracing::warn!(
                category = "checkpoints",
                "too many hosts; checkpoint skipped"
            );
            return None;
        }
        Some(self.lanes.entry(host.clone()).or_default())
    }

    /// Queue a checkpoint of `checkout`. One still waiting for the same
    /// checkout takes the newer label instead: it will snapshot the same files.
    fn capture(&mut self, checkout: Checkout, label: String) {
        let Some(lane) = self.lane(&checkout.host) else {
            return;
        };
        if let Some(job) = lane
            .queue
            .iter_mut()
            .find(|job| job.checkout == checkout && matches!(job.request, Request::Capture { .. }))
        {
            job.request = Request::Capture { label };
            return;
        }
        if lane.queue.len() >= QUEUE_LIMIT {
            tracing::warn!(category = "checkpoints", "checkpoint queue full; skipped");
            return;
        }
        lane.queue.push_back(Job {
            checkout,
            request: Request::Capture { label },
        });
    }

    /// Ask for `checkout`'s list ahead of any waiting checkpoints: the user
    /// is looking at it.
    fn list(&mut self, checkout: Checkout) {
        let Some(lane) = self.lane(&checkout.host) else {
            return;
        };
        let job = Job {
            checkout,
            request: Request::List,
        };
        if !lane.queue.contains(&job) {
            lane.queue.push_front(job);
        }
    }

    /// Open the dialog on `checkout` and load its list.
    pub fn open(&mut self, checkout: Checkout, title: String, workspace_id: String) {
        self.view = Some(View {
            checkout: checkout.clone(),
            title,
            workspace_id,
            listing: Listing::Loading,
            selected: None,
            confirming: None,
            restoring: false,
            error: None,
        });
        self.list(checkout);
    }

    /// Close the dialog. A restore already running still finishes and is
    /// reported through [`Checkpoints::poll`].
    pub fn close(&mut self) {
        self.view = None;
    }

    /// Start restoring the checkpoint the dialog is confirming.
    pub fn restore(&mut self) {
        let Some(view) = &mut self.view else {
            return;
        };
        if view.restoring {
            return;
        }
        let Some(id) = view
            .confirming_checkpoint()
            .filter(|checkpoint| view.restorable(checkpoint))
            .map(|checkpoint| checkpoint.id.clone())
        else {
            return;
        };
        view.restoring = true;
        view.error = None;
        let job = Job {
            checkout: view.checkout.clone(),
            request: Request::Restore { id },
        };
        match self.lane(&job.checkout.host) {
            Some(lane) => lane.queue.push_front(job),
            None => {
                if let Some(view) = &mut self.view {
                    view.restoring = false;
                    view.error = Some("Too many hosts are busy with checkpoints.".into());
                }
            }
        }
    }

    /// A stamp later than every one before it: milliseconds since the epoch,
    /// zero-padded so names sort by age.
    fn stamp(&mut self) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        self.last_stamp = now.max(self.last_stamp + 1);
        format!("{:016}", self.last_stamp)
    }

    /// Take finished answers and start the next job on each idle host.
    /// Returns whether the dialog changed, and any restore that finished.
    pub fn poll(&mut self) -> (bool, Vec<Restored>) {
        let mut changed = false;
        let mut restored = Vec::new();
        let mut answers = Vec::new();
        for lane in self.lanes.values_mut() {
            if let (Some(worker), Some(_)) = (&lane.worker, &lane.running) {
                match worker.results.try_recv() {
                    Ok(answer) => answers.extend(lane.running.take().map(|job| (job, answer))),
                    Err(mpsc::TryRecvError::Empty) => {}
                    Err(mpsc::TryRecvError::Disconnected) => {
                        lane.worker = None;
                        answers.extend(lane.running.take().map(|job| {
                            let answer = job.request.failed(Error::CheckpointWorker);
                            (job, answer)
                        }));
                    }
                }
            }
        }
        for (job, answer) in answers {
            changed |= self.apply(job, answer, &mut restored);
        }
        let idle: Vec<Host> = self
            .lanes
            .iter()
            .filter(|(_, lane)| lane.running.is_none() && !lane.queue.is_empty())
            .map(|(host, _)| host.clone())
            .collect();
        let mut failures = Vec::new();
        for host in idle {
            let stamp = self.stamp();
            let Some(lane) = self.lanes.get_mut(&host) else {
                continue;
            };
            let Some(job) = lane.queue.pop_front() else {
                continue;
            };
            if lane.worker.is_none() {
                match spawn() {
                    Ok(worker) => lane.worker = Some(worker),
                    Err(error) => {
                        tracing::warn!(category = "checkpoints", %error, "no checkpoint worker");
                        let answer = job.request.failed(error);
                        failures.push((job, answer));
                        continue;
                    }
                }
            }
            if let Some(worker) = &lane.worker {
                match worker.requests.try_send((job.clone(), stamp)) {
                    Ok(()) => lane.running = Some(job),
                    Err(mpsc::TrySendError::Full((job, _))) => lane.queue.push_front(job),
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        lane.worker = None;
                        lane.queue.push_front(job);
                    }
                }
            }
        }
        for (job, answer) in failures {
            changed |= self.apply(job, answer, &mut restored);
        }
        // An idle host's thread ends with its lane; the next job starts one.
        self.lanes
            .retain(|_, lane| lane.running.is_some() || !lane.queue.is_empty());
        (changed, restored)
    }

    fn apply(&mut self, job: Job, answer: Answer, restored: &mut Vec<Restored>) -> bool {
        let viewed = self
            .view
            .as_ref()
            .is_some_and(|view| view.checkout == job.checkout);
        match answer {
            Answer::Captured(result) => match result {
                Ok(Some(_)) if viewed => {
                    self.list(job.checkout);
                    false
                }
                Ok(_) => false,
                Err(error) => {
                    tracing::warn!(category = "checkpoints", %error, "checkpoint not taken");
                    false
                }
            },
            Answer::Listed(result) => {
                let Some(view) = self.view.as_mut().filter(|_| viewed) else {
                    return false;
                };
                view.listing = match result {
                    Ok(list) => Listing::Ready(list),
                    Err(error) => Listing::Failed(describe(&error)),
                };
                let count = match &view.listing {
                    Listing::Ready(list) => list.len(),
                    _ => 0,
                };
                view.selected = view.selected.filter(|index| *index < count);
                if view.confirming_checkpoint().is_none() && !view.restoring {
                    view.confirming = None;
                }
                true
            }
            Answer::Restored(result) => {
                if let Some(view) = self.view.as_mut().filter(|_| viewed) {
                    view.restoring = false;
                    match &result {
                        // The list is about to change under the selection.
                        Ok(()) => {
                            view.confirming = None;
                            view.selected = None;
                        }
                        Err(error) => view.error = Some(describe(error)),
                    }
                    self.list(job.checkout.clone());
                }
                restored.push(Restored {
                    checkout: job.checkout,
                    result,
                });
                true
            }
        }
    }
}

/// The display boundary: an error and every cause behind it.
pub(crate) fn describe(error: &Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// How long ago `created` was, coarsely, from `now` (both Unix seconds).
pub(crate) fn age(created: i64, now: i64) -> String {
    let seconds = now.saturating_sub(created).max(0);
    match seconds {
        0..60 => "just now".to_owned(),
        60..3600 => format!("{} min ago", seconds / 60),
        3600..86400 => format!("{} h ago", seconds / 3600),
        _ => format!("{} d ago", seconds / 86400),
    }
}
