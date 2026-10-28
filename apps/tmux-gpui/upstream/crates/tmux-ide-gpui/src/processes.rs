//! The processes running under one pane: its own process (usually the shell
//! or agent Herdr started), and every process below it, with CPU and memory,
//! and a way to signal exactly the ones the user picked.
//!
//! Herdr names the pane's process; its GUI connection does not carry process
//! details, so a worker asks the `herdr` CLI (`pane process-info`) as Teleport
//! does, then lists this machine's processes with `sysinfo` and keeps the
//! pane's subtree. Only a daemon on this machine is watched: a remote pane's
//! pids mean nothing here. The worker samples every couple of seconds while a
//! pane's process list is open, and stops when it closes.

mod tree;

#[cfg(test)]
mod tests;

use crate::{Error, Result};
use herdr_client::{ConnectTarget, ScriptHost, ScriptLimits, run_script, shell_quote};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind};
pub(crate) use tree::{Entry, Identity, Listing, Refusal, Row};

const INTERVAL: Duration = Duration::from_secs(2);
/// A failed lookup is tried again after this long.
const RETRY: Duration = Duration::from_secs(10);
/// After a kill, and while the first usage is measured, the next listing
/// comes sooner. Above `sysinfo`'s shortest CPU interval on every platform.
const SETTLE: Duration = Duration::from_millis(300);
/// `sysinfo` reports a process's CPU from its third listing: the first finds
/// it, the second records its CPU time, the third compares with that.
const MEASURED_AFTER: u8 = 2;
/// Rows shown; a runaway fork still counts in the totals.
const ROW_LIMIT: usize = 200;
/// A command line is display text; longer ones are cut.
const COMMAND_LIMIT: usize = 512;
const QUERY_LIMITS: ScriptLimits = ScriptLimits {
    output: 256 * 1024,
    idle: Duration::from_secs(10),
};

/// The daemon a pane belongs to, as its `herdr` CLI addresses it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Daemon {
    Default,
    Session(String),
}

impl Daemon {
    /// None for a daemon on another machine, or behind a custom socket the
    /// CLI cannot be pointed at: its pids are not this machine's to list.
    /// None everywhere but Linux and macOS, whose `/bin/sh` runs the CLI.
    pub(crate) fn for_target(target: &ConnectTarget) -> Option<Self> {
        if !cfg!(any(target_os = "linux", target_os = "macos")) {
            return None;
        }
        match target {
            ConnectTarget::Local => Some(Self::Default),
            ConnectTarget::Session { name, .. } => Some(Self::Session(name.clone())),
            ConnectTarget::Ssh { .. } | ConnectTarget::Wsl { .. } | ConnectTarget::Socket(_) => {
                None
            }
            #[cfg(feature = "cloud")]
            ConnectTarget::Cloud { .. } => None,
        }
    }

    /// The script asking this daemon about `pane`'s process.
    fn script(&self, executable: &Path, pane: &str) -> Result<String> {
        let executable = executable.to_str().ok_or(Error::ProcessesExecutable)?;
        let session = match self {
            Self::Default => String::new(),
            Self::Session(name) => format!(" --session {}", shell_quote(name)),
        };
        Ok(format!(
            "exec {}{session} pane process-info --pane {}\n",
            shell_quote(executable),
            shell_quote(pane)
        ))
    }

    /// Blocking: runs the CLI and waits for its answer.
    fn process_info(
        &self,
        pane: &str,
        cancelled: &AtomicBool,
    ) -> Result<crate::teleport::ProcessInfo> {
        let script = self.script(&crate::daemon::executable(), pane)?;
        let mut output = Vec::new();
        run_script(
            ScriptHost::Local,
            &script,
            std::io::empty(),
            &mut output,
            QUERY_LIMITS,
            cancelled,
        )
        .map_err(Error::ProcessesQuery)?;
        serde_json::from_slice::<crate::teleport::Envelope<crate::teleport::ProcessInfoResult>>(
            &output,
        )
        .map(|envelope| envelope.result.process_info)
        .map_err(Error::ProcessesAnswer)
    }
}

/// What became of one process the user asked to end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Sent SIGTERM (terminated, on Windows).
    Signalled,
    /// The OS refused the signal, typically for another user's process.
    Failed,
    Refused(Refusal),
}

#[derive(Debug, PartialEq)]
pub(crate) enum Command {
    Kill(Vec<Identity>),
}

pub(crate) enum Update {
    Listing(Result<Listing>),
    Killed(Vec<(Identity, Outcome)>),
}

/// One pane's worker. Dropping it stops the worker without waiting for it.
pub(crate) struct Watch {
    commands: mpsc::SyncSender<Command>,
    updates: mpsc::Receiver<Update>,
    cancelled: Arc<AtomicBool>,
}

impl Drop for Watch {
    /// Abandons a CLI call in flight; the closed channel ends the loop.
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl Watch {
    pub(crate) fn start(daemon: Daemon, pane: String) -> Result<Self> {
        let (commands, received) = mpsc::sync_channel(1);
        let (sender, updates) = mpsc::sync_channel(4);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = cancelled.clone();
        thread::Builder::new()
            .name("herdr-pane-processes".into())
            .spawn(move || run(&daemon, &pane, &received, &sender, &shared))
            .map_err(Error::ProcessesWorker)?;
        Ok(Self {
            commands,
            updates,
            cancelled,
        })
    }

    /// Asks the worker to signal exactly `victims`, after checking each is
    /// still the process listed and still below the pane's process.
    pub(crate) fn kill(&self, victims: Vec<Identity>) -> Result<()> {
        self.commands
            .try_send(Command::Kill(victims))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::ProcessesBusy,
                mpsc::TrySendError::Disconnected(_) => Error::ProcessesStopped,
            })
    }

    /// The worker's next answer, if one is ready.
    pub(crate) fn try_update(&self) -> Result<Option<Update>> {
        match self.updates.try_recv() {
            Ok(update) => Ok(Some(update)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(Error::ProcessesStopped),
        }
    }

    /// A watch with no worker: the test plays the worker's part.
    #[cfg(test)]
    pub(crate) fn fake() -> (Self, mpsc::SyncSender<Update>, mpsc::Receiver<Command>) {
        let (commands, received) = mpsc::sync_channel(1);
        let (sender, updates) = mpsc::sync_channel(4);
        (
            Self {
                commands,
                updates,
                cancelled: Arc::new(AtomicBool::new(false)),
            },
            sender,
            received,
        )
    }
}

fn run(
    daemon: &Daemon,
    pane: &str,
    commands: &mpsc::Receiver<Command>,
    updates: &mpsc::SyncSender<Update>,
    cancelled: &AtomicBool,
) {
    // Linux `sysinfo` otherwise keeps every process's stat file open, up to
    // half this app's descriptors, which its terminals need. Elsewhere a no-op.
    sysinfo::set_open_files_limit(0);
    let mut system = System::new();
    let mut sightings = HashMap::new();
    let mut listed = 0;
    let mut root = None;
    let mut due = Instant::now();
    loop {
        match commands.recv_timeout(due.saturating_duration_since(Instant::now())) {
            Ok(Command::Kill(victims)) => {
                let outcomes = kill(&mut system, root, &victims);
                // Blocks while the UI is behind; a closed list ends it.
                if updates.send(Update::Killed(outcomes)).is_err() {
                    return;
                }
                due = Instant::now() + SETTLE;
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let result = sample(daemon, pane, &mut system, &mut sightings, cancelled);
        // Without a current listing nothing is known to be below the pane,
        // so kills are refused until the next one.
        root = result.as_ref().ok().and_then(Listing::root);
        due = Instant::now()
            + match &result {
                Err(_) => RETRY,
                // Only on opening: processes appearing later wait for the
                // usual interval, however many a build starts.
                Ok(_) if listed < MEASURED_AFTER => {
                    listed += 1;
                    SETTLE
                }
                Ok(_) => INTERVAL,
            };
        if updates.send(Update::Listing(result)).is_err() {
            return;
        }
    }
}

fn sample(
    daemon: &Daemon,
    pane: &str,
    system: &mut System,
    sightings: &mut HashMap<Identity, u8>,
    cancelled: &AtomicBool,
) -> Result<Listing> {
    let info = daemon.process_info(pane, cancelled)?;
    let root = info.shell_pid.ok_or(Error::ProcessesNoRoot)?;
    refresh(system);
    let previous = std::mem::take(sightings);
    let entries = system
        .processes()
        .values()
        .filter(|process| process.thread_kind().is_none())
        .map(|process| {
            let identity = identity(process);
            (process, identity, sight(&previous, sightings, identity))
        })
        .map(|(process, identity, measured)| Entry {
            identity,
            parent: process.parent().map(Pid::as_u32),
            name: display(process.name().to_string_lossy().chars()),
            command: display(
                process
                    .cmd()
                    .iter()
                    .map(|arg| arg.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars(),
            ),
            cpu: measured.then(|| process.cpu_usage().max(0.)),
            memory: process.memory(),
        });
    tree::listing(entries, root, &info.foreground_pids(), ROW_LIMIT)
        .ok_or(Error::ProcessesRootExited)
}

/// Records that `identity` is listed now, given how often the last listing
/// had seen it; true once its CPU usage is measured.
fn sight(
    previous: &HashMap<Identity, u8>,
    sightings: &mut HashMap<Identity, u8>,
    identity: Identity,
) -> bool {
    let seen = previous.get(&identity).copied().unwrap_or(0);
    sightings.insert(identity, seen.saturating_add(1).min(MEASURED_AFTER));
    seen >= MEASURED_AFTER
}

/// Lists every process. A kill's check refreshes the same way as a sample:
/// macOS measures CPU from the last refresh of any kind, so a lighter one in
/// between would skew the next sample's usage.
fn refresh(system: &mut System) {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
}

fn identity(process: &sysinfo::Process) -> Identity {
    Identity {
        pid: process.pid().as_u32(),
        started: process.start_time(),
    }
}

/// Names and arguments are the processes' own, untrusted text: bounded, and
/// with control characters shown as spaces.
fn display(text: impl Iterator<Item = char>) -> String {
    text.take(COMMAND_LIMIT)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// Signals each of `victims` that is still the process listed, below `root`.
/// A fresh listing guards against pids reused since the user chose; the
/// signal goes to that exact pid, never to a group or a name.
fn kill(
    system: &mut System,
    root: Option<Identity>,
    victims: &[Identity],
) -> Vec<(Identity, Outcome)> {
    refresh(system);
    let table: HashMap<u32, (Option<u32>, u64)> = system
        .processes()
        .values()
        .filter(|process| process.thread_kind().is_none())
        .map(|process| {
            (
                process.pid().as_u32(),
                (process.parent().map(Pid::as_u32), process.start_time()),
            )
        })
        .collect();
    victims
        .iter()
        .map(|victim| {
            let checked = root
                .ok_or(Refusal::RootExited)
                .and_then(|root| tree::check(&table, root, *victim));
            let outcome = match checked {
                Ok(()) => signal(system, victim.pid),
                Err(refusal) => Outcome::Refused(refusal),
            };
            (*victim, outcome)
        })
        .collect()
}

fn signal(system: &System, pid: u32) -> Outcome {
    let Some(process) = system.process(Pid::from_u32(pid)) else {
        return Outcome::Refused(Refusal::Exited);
    };
    // SIGTERM lets the process clean up. Windows has no such signal, and
    // terminates the process instead.
    if process
        .kill_with(Signal::Term)
        .unwrap_or_else(|| process.kill())
    {
        Outcome::Signalled
    } else {
        Outcome::Failed
    }
}
