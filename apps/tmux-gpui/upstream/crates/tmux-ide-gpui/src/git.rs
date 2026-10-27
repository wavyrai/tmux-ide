//! Working-tree status and Git write operations for local checkouts.
//!
//! One worker thread owns every child process, so the UI thread only queues a
//! request and reads the result on a later tick. The focused checkout gets a
//! counted status; every other listed workspace gets a cheaper dirty probe,
//! round-robin and rate limited, so the sidebar can mark uncommitted work
//! without a process per row per frame. Commit, push and pull request creation
//! are explicit user actions and are never retried or replayed automatically.
use crate::{
    Error,
    pull_request::{Input, clean, local_checkout, origin_repository, run, run_bytes},
};
use secrecy::SecretString;
use std::{
    collections::VecDeque,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

/// Status refreshes touch the disk, so they are slow-polled and only for the
/// checkout the chrome is actually showing.
const REFRESH: Duration = Duration::from_secs(5);
const ERROR_BACKOFF: Duration = Duration::from_secs(60);
/// Rows the user is not working in change rarely and cost a process each, so
/// they refresh slowly and a failure waits longer still.
const PROBE_REFRESH: Duration = Duration::from_secs(30);
const PROBE_BACKOFF: Duration = Duration::from_secs(300);
/// One scan per second at most, and a bounded cache: a daemon listing hundreds
/// of workspaces cannot turn into hundreds of queued probes.
const SCAN_INTERVAL: Duration = Duration::from_secs(1);
const CACHE_LIMIT: usize = 128;
const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
/// Signing a commit or authenticating a push can wait on a hardware key.
const OPERATION_TIMEOUT: Duration = Duration::from_secs(180);
const API_TIMEOUT: Duration = Duration::from_secs(30);
const MESSAGE_LIMIT: usize = 4096;
const TITLE_LIMIT: usize = 256;

const REPOSITORY_QUERY: &str = r#"query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { id defaultBranchRef { name } }
}"#;
const CREATE_MUTATION: &str = r#"mutation($repository: ID!, $base: String!, $head: String!, $title: String!, $body: String!) {
  createPullRequest(input: {repositoryId: $repository, baseRefName: $base, headRefName: $head, title: $title, body: $body}) {
    pullRequest { number url }
  }
}"#;

/// Tracked line changes against HEAD plus the untracked entries `git add -A`
/// would also stage, so the chrome never understates what a commit includes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Status {
    pub additions: u64,
    pub deletions: u64,
    pub untracked: u64,
}

impl Status {
    pub fn dirty(&self) -> bool {
        self.additions > 0 || self.deletions > 0 || self.untracked > 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Action {
    Commit(String),
    Push,
    CreatePullRequest,
}

impl Action {
    pub fn running_label(&self) -> &'static str {
        match self {
            Self::Commit(_) => "Committing...",
            Self::Push => "Pushing...",
            Self::CreatePullRequest => "Creating pull request...",
        }
    }
}

/// What an action achieved, in the user's terms. `url` is offered as a link
/// rather than opened by the worker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Outcome {
    pub message: String,
    pub url: Option<String>,
}

enum Job {
    Status,
    /// Is there anything to commit? Cheaper than counting lines, and all a
    /// sidebar row needs to show its dot.
    Dirty,
    Run(Action, Option<Arc<SecretString>>),
}

enum Completion {
    Status(crate::Result<Status>),
    Dirty(crate::Result<bool>),
    Action(crate::Result<Outcome>),
}

/// One listed checkout's probe. A failure is remembered as "unknown" rather
/// than "clean", so a broken repository shows no dot instead of a wrong one.
struct Probe {
    input: Input,
    dirty: Option<bool>,
    due: Instant,
    used: Instant,
}

struct Worker {
    requests: mpsc::SyncSender<(u64, Input, Job)>,
    results: mpsc::Receiver<(Input, Completion)>,
}

/// Client-local Git state for the focused checkout. Dropping it retires every
/// in-flight request; no result of an old checkout can reach a new one.
#[derive(Default)]
pub(super) struct Git {
    worker: Option<Worker>,
    generation: Arc<AtomicU64>,
    busy: bool,
    waiting: Option<(Input, Job)>,
    input: Option<Input>,
    status: Option<Status>,
    due: Option<Instant>,
    running: Option<Action>,
    error: Option<String>,
    outcome: Option<Outcome>,
    probes: Vec<Probe>,
    queue: VecDeque<Input>,
    next_scan: Option<Instant>,
}

impl Drop for Git {
    fn drop(&mut self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
    }
}

impl Git {
    /// Chrome fixture: a tracked checkout and its status, with no worker and
    /// therefore no scheduled Git work.
    #[cfg(test)]
    pub fn fixture(input: Input, status: Status) -> Self {
        let mut git = Self::default();
        git.input = Some(input);
        git.status = Some(status);
        git
    }

    /// Chrome fixture: a probe answer for a listed checkout, with no worker
    /// and therefore no scheduled Git work.
    #[cfg(test)]
    pub fn seed_probe(&mut self, input: Input, dirty: bool, now: Instant) {
        self.record_probe(input, Some(dirty), now);
    }

    pub fn tracked(&self) -> Option<&Input> {
        self.input.as_ref()
    }

    pub fn status(&self) -> Option<Status> {
        self.status
    }

    pub fn running(&self) -> Option<&Action> {
        self.running.as_ref()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    /// Follow the focused checkout and schedule the next read-only refresh.
    /// `refresh` is false while the window is inactive: the last known status
    /// stays on screen instead of polling Git behind the user's back.
    pub fn track(&mut self, input: Option<Input>, refresh: bool, now: Instant) -> bool {
        let mut changed = false;
        if self.input != input {
            // A running action keeps running: its result still belongs to the
            // checkout it was started for and is reported against that input.
            self.input = input;
            self.status = None;
            self.error = None;
            self.outcome = None;
            self.due = Some(now);
            changed = true;
        }
        let Some(input) = self.input.clone() else {
            return changed;
        };
        if refresh && self.waiting.is_none() && !self.busy && self.due.is_some_and(|due| now >= due)
        {
            self.due = None;
            self.waiting = Some((input, Job::Status));
        }
        changed
    }

    /// Does this checkout have anything to commit? `None` while unknown, so a
    /// row shows nothing rather than claiming a clean tree. Pure cache read:
    /// rendering never schedules Git work.
    pub fn dirty(&self, repo_key: &str, branch: &str) -> Option<bool> {
        if self.input.as_ref().is_some_and(|input| {
            input.repo_key.as_deref() == Some(repo_key) && input.branch == branch
        }) && let Some(status) = self.status
        {
            return Some(status.dirty());
        }
        self.probes
            .iter()
            .find(|probe| {
                probe.input.repo_key.as_deref() == Some(repo_key) && probe.input.branch == branch
            })
            .and_then(|probe| probe.dirty)
    }

    /// Follow the listed checkouts: drop probes for workspaces that are gone
    /// and queue the ones whose answer is missing or stale.
    pub fn track_listed(
        &mut self,
        inputs: impl IntoIterator<Item = Input>,
        refresh: bool,
        now: Instant,
    ) {
        let mut listed = Vec::new();
        for input in inputs.into_iter().take(CACHE_LIMIT) {
            if !listed.contains(&input) {
                listed.push(input);
            }
        }
        self.probes.retain(|probe| listed.contains(&probe.input));
        self.queue.retain(|input| listed.contains(input));
        if !refresh || self.next_scan.is_some_and(|next| now < next) {
            return;
        }
        self.next_scan = Some(now + SCAN_INTERVAL);
        for input in listed {
            // The focused checkout is counted by its own status refresh.
            if self.input.as_ref() == Some(&input) || self.queue.contains(&input) {
                continue;
            }
            if self
                .probes
                .iter()
                .find(|probe| probe.input == input)
                .is_none_or(|probe| now >= probe.due)
            {
                self.queue.push_back(input);
            }
        }
    }

    fn record_probe(&mut self, input: Input, dirty: Option<bool>, now: Instant) {
        let due = now
            + if dirty.is_some() {
                PROBE_REFRESH
            } else {
                PROBE_BACKOFF
            };
        if let Some(probe) = self.probes.iter_mut().find(|probe| probe.input == input) {
            probe.dirty = dirty;
            probe.due = due;
            probe.used = now;
            return;
        }
        if self.probes.len() == CACHE_LIMIT
            && let Some((index, _)) = self
                .probes
                .iter()
                .enumerate()
                .min_by_key(|(_, probe)| probe.used)
        {
            self.probes.remove(index);
        }
        self.probes.push(Probe {
            input,
            dirty,
            due,
            used: now,
        });
    }

    /// Queue an explicit user action against the tracked checkout.
    pub fn start(&mut self, action: Action, token: Option<Arc<SecretString>>) -> crate::Result<()> {
        if self.running.is_some() {
            return Err(Error::GitBusy);
        }
        let input = self.input.clone().ok_or(Error::GitNoCheckout)?;
        if let Action::Commit(message) = &action
            && (message.trim().is_empty() || message.len() > MESSAGE_LIMIT)
        {
            return Err(Error::GitCommitMessage);
        }
        if matches!(action, Action::CreatePullRequest) && token.is_none() {
            return Err(Error::GitHubAuthentication);
        }
        self.error = None;
        self.outcome = None;
        self.running = Some(action.clone());
        self.waiting = Some((input, Job::Run(action, token)));
        Ok(())
    }

    pub fn poll(&mut self, now: Instant) -> bool {
        let mut changed = false;
        if let Some(worker) = &self.worker {
            match worker.results.try_recv() {
                Ok((input, completion)) => {
                    self.busy = false;
                    changed = true;
                    match completion {
                        // A status of a checkout the chrome no longer shows is
                        // dropped rather than painted over the current one.
                        Completion::Status(_) if self.input.as_ref() != Some(&input) => {}
                        Completion::Status(Ok(status)) => {
                            self.status = Some(status);
                            self.error = None;
                            self.due = Some(now + REFRESH);
                        }
                        Completion::Status(Err(error)) => {
                            self.status = None;
                            if self.running.is_none() {
                                self.error = Some(error.to_string());
                            }
                            self.due = Some(now + ERROR_BACKOFF);
                        }
                        Completion::Dirty(result) => {
                            self.record_probe(input, result.ok(), now);
                        }
                        Completion::Action(result) => {
                            self.running = None;
                            match result {
                                Ok(outcome) => self.outcome = Some(outcome),
                                Err(error) => self.error = Some(error.to_string()),
                            }
                            // A commit or push changed the tree it reported on.
                            if self.input.as_ref() == Some(&input) {
                                self.due = Some(now);
                            }
                        }
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.busy = false;
                    self.waiting = None;
                    self.worker = None;
                    self.running = None;
                    self.error = Some(Error::GitWorker.to_string());
                    self.due = Some(now + ERROR_BACKOFF);
                    return true;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if !self.busy
            && self.waiting.is_none()
            && let Some(input) = self.queue.pop_front()
        {
            self.waiting = Some((input, Job::Dirty));
        }
        if !self.busy
            && let Some((input, job)) = self.waiting.take()
        {
            if self.worker.is_none() {
                let (requests, incoming) = mpsc::sync_channel::<(u64, Input, Job)>(1);
                let (outgoing, results) = mpsc::sync_channel(1);
                let current = self.generation.clone();
                match thread::Builder::new()
                    .name("herdr-git".into())
                    .spawn(move || {
                        for (generation, input, job) in incoming {
                            let cancelled = || current.load(Ordering::Relaxed) != generation;
                            let completion = execute(&input, job, &cancelled);
                            if outgoing.send((input, completion)).is_err() {
                                break;
                            }
                        }
                    }) {
                    Ok(_) => self.worker = Some(Worker { requests, results }),
                    Err(source) => {
                        self.running = None;
                        self.error = Some(
                            Error::GitProcess {
                                operation: "start the Git worker",
                                source,
                            }
                            .to_string(),
                        );
                        self.due = Some(now + ERROR_BACKOFF);
                        return true;
                    }
                }
            }
            if let Some(worker) = &self.worker {
                let generation = self.generation.load(Ordering::Relaxed);
                match worker.requests.try_send((generation, input, job)) {
                    Ok(()) => self.busy = true,
                    Err(mpsc::TrySendError::Full((_, input, job))) => {
                        self.waiting = Some((input, job))
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        self.worker = None;
                        self.running = None;
                        self.error = Some(Error::GitWorker.to_string());
                        self.due = Some(now + ERROR_BACKOFF);
                        changed = true;
                    }
                }
            }
        }
        changed
    }
}

fn execute(input: &Input, job: Job, cancelled: &impl Fn() -> bool) -> Completion {
    match job {
        Job::Status => {
            Completion::Status(status(input, Instant::now() + STATUS_TIMEOUT, cancelled))
        }
        Job::Dirty => Completion::Dirty(dirty(input, Instant::now() + STATUS_TIMEOUT, cancelled)),
        // Writes are never cancelled: killing `git commit` or `git push`
        // halfway through can leave an index lock or a half-written ref behind,
        // so only their own deadline ends them.
        Job::Run(action, token) => Completion::Action(perform(input, action, token, &|| false)),
    }
}

fn status(
    input: &Input,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<Status> {
    let checkout = local_checkout(input, deadline, cancelled)?;
    checkout_status(&checkout, deadline, cancelled)
}

/// Porcelain output is machine readable and collapses untracked directories,
/// so an unignored build directory stays one entry rather than thousands.
fn dirty(input: &Input, deadline: Instant, cancelled: &impl Fn() -> bool) -> crate::Result<bool> {
    let checkout = local_checkout(input, deadline, cancelled)?;
    let status = git(
        &checkout,
        &["status", "--porcelain", "--untracked-files=normal", "-z"],
        "read working tree state",
        deadline,
        cancelled,
    )?;
    Ok(!status.is_empty())
}

fn checkout_status(
    checkout: &str,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<Status> {
    let numstat = git(
        checkout,
        &["diff", "--numstat", "HEAD"],
        "read working tree changes",
        deadline,
        cancelled,
    )?;
    // Untracked directories collapse to one entry, so an unignored build
    // directory cannot push the listing past the worker's output limit.
    let untracked = git(
        checkout,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
            "-z",
        ],
        "list untracked files",
        deadline,
        cancelled,
    )?;
    let mut status = parse_numstat(&numstat);
    status.untracked = untracked
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .count() as u64;
    Ok(status)
}

/// `--numstat` is machine readable in any locale; binary files report `-` and
/// contribute no line counts.
pub(super) fn parse_numstat(text: &str) -> Status {
    let mut status = Status::default();
    for line in text.lines() {
        let mut fields = line.split('\t');
        let additions = fields.next().and_then(|field| field.parse::<u64>().ok());
        let deletions = fields.next().and_then(|field| field.parse::<u64>().ok());
        status.additions = status.additions.saturating_add(additions.unwrap_or(0));
        status.deletions = status.deletions.saturating_add(deletions.unwrap_or(0));
    }
    status
}

fn perform(
    input: &Input,
    action: Action,
    token: Option<Arc<SecretString>>,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<Outcome> {
    let deadline = Instant::now() + OPERATION_TIMEOUT;
    let checkout = local_checkout(input, deadline, cancelled)?;
    match action {
        Action::Commit(message) => commit(&checkout, &message, deadline, cancelled),
        Action::Push => push(&checkout, &input.branch, deadline, cancelled),
        Action::CreatePullRequest => {
            let token = token.ok_or(Error::GitHubAuthentication)?;
            create_pull_request(&checkout, &input.branch, &token, deadline, cancelled)
        }
    }
}

fn commit(
    checkout: &str,
    message: &str,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<Outcome> {
    if !checkout_status(checkout, deadline, cancelled)?.dirty() {
        return Err(Error::GitNothingToCommit);
    }
    git(
        checkout,
        &["add", "-A"],
        "stage changes",
        deadline,
        cancelled,
    )?;
    git(
        checkout,
        &["commit", "-m", message],
        "commit",
        deadline,
        cancelled,
    )?;
    let head = git(
        checkout,
        &["log", "-1", "--pretty=format:%h %s"],
        "read the new commit",
        deadline,
        cancelled,
    )?;
    Ok(Outcome {
        message: format!("Committed {}", clean(&head)),
        url: None,
    })
}

fn push(
    checkout: &str,
    branch: &str,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<Outcome> {
    git(
        checkout,
        &["push", "--set-upstream", "origin", branch],
        "push",
        deadline,
        cancelled,
    )?;
    Ok(Outcome {
        message: format!("Pushed {branch} to origin"),
        url: None,
    })
}

fn create_pull_request(
    checkout: &str,
    branch: &str,
    token: &SecretString,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<Outcome> {
    let (owner, repo) = origin_repository(checkout, deadline, cancelled)?;
    let title = clean(&git(
        checkout,
        &["log", "-1", "--pretty=format:%s"],
        "read the commit subject",
        deadline,
        cancelled,
    )?);
    let title: String = title.trim().chars().take(TITLE_LIMIT).collect();
    if title.is_empty() {
        return Err(Error::GitPullRequestTitle);
    }
    // The head ref must exist on GitHub before a pull request can reference it.
    git(
        checkout,
        &["push", "--set-upstream", "origin", branch],
        "push",
        deadline,
        cancelled,
    )?;
    let mut cooldown = None;
    let repository = crate::github::graphql(
        "create_pr_repository",
        token,
        REPOSITORY_QUERY,
        serde_json::json!({"owner": owner, "repo": repo}),
        API_TIMEOUT,
        cancelled,
        &mut cooldown,
    )?;
    let id = repository["data"]["repository"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or(Error::PrRepository)?
        .to_owned();
    let base = repository["data"]["repository"]["defaultBranchRef"]["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .ok_or(Error::PrRepository)?
        .to_owned();
    if base == branch {
        return Err(Error::GitPullRequestBase);
    }
    let created = crate::github::graphql(
        "create_pr",
        token,
        CREATE_MUTATION,
        serde_json::json!({
            "repository": id, "base": base, "head": branch, "title": title, "body": ""
        }),
        API_TIMEOUT,
        cancelled,
        &mut cooldown,
    )?;
    parse_created(&created, &owner, &repo)
}

fn parse_created(response: &serde_json::Value, owner: &str, repo: &str) -> crate::Result<Outcome> {
    let pr = &response["data"]["createPullRequest"]["pullRequest"];
    let number = pr["number"].as_u64().filter(|number| *number > 0);
    let url = pr["url"].as_str().unwrap_or_default();
    let expected = number.map(|number| format!("https://github.com/{owner}/{repo}/pull/{number}"));
    if expected.as_deref() != Some(url) {
        return Err(Error::PrIdentity);
    }
    Ok(Outcome {
        message: format!("Opened pull request #{}", number.unwrap_or_default()),
        url: expected,
    })
}

/// Every Git child runs through the shared process policy: no shell, no
/// terminal prompts, bounded output, and a deadline the caller owns.
pub(crate) fn git(
    checkout: &str,
    args: &[&str],
    operation: &'static str,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<String> {
    let (ok, output) = run(&mut command(checkout, args), deadline, cancelled)?;
    if ok {
        Ok(output.trim_end_matches(['\r', '\n']).to_owned())
    } else {
        Err(Error::GitFailed {
            operation,
            details: clean(output.trim()),
        })
    }
}

/// [`git`] for output that may be large or not text: up to `limit` bytes,
/// as Git wrote them.
pub(crate) fn git_bytes(
    checkout: &str,
    args: &[&str],
    operation: &'static str,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
    limit: usize,
) -> crate::Result<Vec<u8>> {
    let (ok, output) = run_bytes(&mut command(checkout, args), deadline, cancelled, limit)?;
    if ok {
        Ok(output)
    } else {
        Err(Error::GitFailed {
            operation,
            details: clean(String::from_utf8_lossy(&output).trim()),
        })
    }
}

/// Git in `checkout`, read-only and without the file monitor.
fn command(checkout: &str, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "core.fsmonitor=false",
            "--no-optional-locks",
            "-C",
            checkout,
        ])
        .args(args);
    command
}

/// Fresh close-time probe, including metadata-only and submodule changes that
/// line counts cannot represent. Remote-tracking refs are the local evidence of
/// a push; this read-only check never contacts a remote.
pub(super) fn close_status(
    input: &Input,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> crate::Result<(bool, bool)> {
    let checkout = local_checkout(input, deadline, cancelled)?;
    let dirty = !git(
        &checkout,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
        "check uncommitted files",
        deadline,
        cancelled,
    )?
    .is_empty();
    let unpushed = !git(
        &checkout,
        &["rev-list", "--max-count=1", "HEAD", "--not", "--remotes"],
        "check unpushed commits",
        deadline,
        cancelled,
    )?
    .is_empty();
    Ok((dirty, unpushed))
}

#[cfg(test)]
mod tests;
