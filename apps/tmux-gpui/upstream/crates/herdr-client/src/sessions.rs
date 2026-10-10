//! The named local sessions one machine's Herdr installation owns, and which of
//! them is running. A session socket outlives the daemon that created it, so a
//! session's state can only come from a connect attempt, never the file itself.
use crate::ssh::CANDIDATES;
use crate::{
    Error, Result, Stream,
    catalog::validate_target,
    discovery::{config_dir, valid_session_name},
    session_socket,
};
#[cfg(unix)]
use crate::{
    limits::POLL,
    ssh::{ChildGuard, script_command},
};
use serde::Deserialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
#[cfg(unix)]
use std::{io::Read, os::fd::OwnedFd, process::Stdio};

/// One scan reports at most this many sessions, like the endpoint catalog's
/// profile cap. More than this is refused rather than silently truncated.
const LIMIT: usize = 64;

/// The root session, which upstream keeps in the configuration directory itself
/// rather than in a subdirectory of `sessions/`.
const DEFAULT: &str = "default";

/// Stop and delete a named session through Herdr after explicit confirmation.
/// This terminates its pane processes. Call only from a background worker.
pub fn delete_local_session(executable: &Path, name: &str) -> Result<()> {
    validate_delete(name)?;
    let command = |operation| {
        let mut command = std::process::Command::new(executable);
        command.args(["session", operation, "--json", "--", name]);
        command
    };
    stop_then_delete(
        || delete_command(command("stop"), Duration::from_secs(20)),
        || delete_command(command("delete"), Duration::from_secs(15)),
    )
}

/// Stop and delete a named session on a saved POSIX device after confirmation.
pub fn delete_remote_session(target: &str, name: &str) -> Result<()> {
    validate_target(target)?;
    validate_delete(name)?;
    #[cfg(unix)]
    {
        delete_command(
            script_command(target, &delete_script(name))?,
            Duration::from_secs(45),
        )
    }
    #[cfg(not(unix))]
    {
        Err(Error::SshUnsupported)
    }
}

fn stop_then_delete(
    stop: impl FnOnce() -> Result<()>,
    delete: impl FnOnce() -> Result<()>,
) -> Result<()> {
    match stop() {
        Ok(()) | Err(Error::SessionDeleteFailed(_)) => {
            // `session stop` refuses an already-stopped/missing session. The
            // delete command is authoritative: it refuses any still-live daemon,
            // including one restarted concurrently by another client.
            delete()
        }
        // Do not continue an uncertain operation or replay it automatically.
        Err(error) => Err(error),
    }
}

pub(crate) fn validate_delete(name: &str) -> Result<()> {
    if !valid_session_name(name) {
        return Err(Error::InvalidSession);
    }
    if name == DEFAULT {
        return Err(Error::DefaultSession);
    }
    Ok(())
}

pub(crate) fn delete_script(name: &str) -> String {
    // Choose the same first CLI that can list sessions. A mutation is never
    // retried with another installation after a refusal or ambiguous result.
    format!(
        r#"{CANDIDATES}
    if [ -n "$path" ] && [ -x "$path" ]; then
        "$path" session list --json >/dev/null 2>&1 || continue
        "$path" session stop --json -- {} >/dev/null 2>&1
        exec "$path" session delete --json -- {}
    fi
done
exit 127"#,
        crate::shell_quote(name),
        crate::shell_quote(name)
    )
}

pub(crate) fn delete_command(mut command: std::process::Command, timeout: Duration) -> Result<()> {
    use std::process::Stdio;
    // No terminal, inherited pipes, or unbounded remote diagnostics. Status is
    // authoritative; a successful spawn is not a successful deletion.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(Error::SessionDeleteFailed(status))
                };
            }
            Err(error) => break Err(Error::Io(error)),
            Ok(None) if started.elapsed() >= timeout => break Err(Error::SessionDeleteTimeout),
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    // Only this exact CLI/SSH child is ours to kill and reap, never the daemon.
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Running,
    Stopped,
}

impl SessionState {
    pub const fn running(self) -> bool {
        matches!(self, Self::Running)
    }
}

/// A local session and the private endpoint this client would attach to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalSession {
    pub name: String,
    pub state: SessionState,
    /// Derived by discovery, so callers never rebuild a session path themselves.
    pub socket: PathBuf,
}

/// A session one SSH host says it owns. Unlike a [`LocalSession`] this is the
/// remote CLI's own answer, not a socket this client probed: the host decided
/// `running`, and there is no remote socket to check it against.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct RemoteSession {
    pub name: String,
    /// Absent from the host's JSON means the session is not running, never a guess.
    #[serde(default)]
    pub running: bool,
}

/// List the local sessions of a release or development installation, `default`
/// first and the rest by name. Performs filesystem and socket I/O in the calling
/// thread's time: call it from a worker, never a rendering thread.
pub fn list_local_sessions(development: bool) -> Result<Vec<LocalSession>> {
    list_with(&config_dir(development), |socket| {
        // A plain connect and drop is the same availability signal upstream's own
        // session list needs. The daemon logs a client only once it handshakes.
        Stream::connect(socket).is_ok()
    })
}

fn list_with(dir: &Path, running: impl Fn(&Path) -> bool) -> Result<Vec<LocalSession>> {
    let names = names(dir).map_err(|error| {
        Error::storage(crate::StorageOperation::Read, &session_root(dir), error)
    })?;
    if names.len() > LIMIT {
        return Err(Error::SessionLimit);
    }
    names
        .into_iter()
        .map(|name| {
            let socket = session_socket(dir, &name)?;
            let state = if running(&socket) {
                SessionState::Running
            } else {
                SessionState::Stopped
            };
            Ok(LocalSession {
                name,
                state,
                socket,
            })
        })
        .collect()
}

fn session_root(dir: &Path) -> PathBuf {
    dir.join("sessions")
}

/// `default` plus every session directory. A missing `sessions/` means this
/// installation has only ever used the root session, not that listing failed.
fn names(dir: &Path) -> io::Result<Vec<String>> {
    let mut names = vec![DEFAULT.to_owned()];
    let entries = match fs::read_dir(session_root(dir)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(names),
        Err(error) => return Err(error),
    };
    let mut named = Vec::new();
    for entry in entries {
        let entry = entry?;
        // file_type does not follow symlinks, so only real session directories
        // are listed and a link out of the configuration root is ignored.
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        if let Some(name) = name.to_str()
            && valid_session_name(name)
        {
            named.push(name.to_owned());
        }
    }
    named.sort_unstable();
    names.append(&mut named);
    Ok(names)
}

/// The whole remote probe's budget: the figure the bridge's discovery already
/// allows, since a listing has to survive the same SSH handshake.
#[cfg(unix)]
const DEADLINE: Duration = Duration::from_secs(15);

/// A host listing `LIMIT` sessions with full socket paths stays well under this.
/// More than that is not a session list, and it is refused instead of buffered.
#[cfg(unix)]
const MAX_OUTPUT: usize = 64 * 1024;

/// The `herdr session list --json` envelope. Only the entries are read: the
/// host's `session_dir` and `socket_path` are its own filesystem, and the default
/// flag follows from a name this client already knows how to attach to.
#[derive(Deserialize)]
struct SessionList {
    sessions: Vec<RemoteSession>,
}

/// List the sessions a saved SSH host owns by running `herdr session list --json`
/// there. The endpoint protocol has no session-list method and `herdr machine` has
/// no session subcommand, so the host's own CLI is the only route, and what it
/// reports is taken at its word. The target is validated before anything spawns.
///
/// This performs a blocking SSH round trip in the calling thread's time: call it
/// from a worker, never a rendering thread. A host with no discoverable Herdr, or
/// one reporting more sessions than a listing may hold, is an error rather than a
/// shorter list.
pub fn list_remote_sessions(target: &str) -> Result<Vec<RemoteSession>> {
    validate_target(target)?;
    #[cfg(unix)]
    {
        parse_session_list(&remote_stdout(target, &session_list_script())?)
    }
    // Handing a socket to a child as its stdout needs `OwnedFd`, which only Unix
    // gives, so this mirrors `ssh::connect`: reject the platform, not the target.
    #[cfg(not(unix))]
    {
        Err(Error::SshUnsupported)
    }
}

/// Ask the host for its own session list. Shares the bridge's discovery loop
/// because a non-interactive SSH `PATH` rarely names herdr, and `continue` past a
/// candidate that fails keeps one stale install from hiding a working one. A
/// candidate that answers ends the probe: without that `exit 0` every remaining
/// root lists its sessions too, and a run that worked exits 127.
pub(crate) fn session_list_script() -> String {
    format!(
        r#"{CANDIDATES}
    if [ -n "$path" ] && [ -x "$path" ]; then
        "$path" session list --json || continue
        exit 0
    fi
done
exit 127"#
    )
}

/// One command's stdout over SSH: killed/reaped on every exit path by `ChildGuard`'s
/// `Drop`, so a host that never answers cannot leave an `ssh` process behind.
/// Stderr and stdin are discarded rather than inherited: remote diagnostics can
/// carry secrets and terminal controls, and a command that reads a terminal it was
/// not given would hang.
#[cfg(unix)]
fn remote_stdout(target: &str, script: &str) -> Result<Vec<u8>> {
    let (mut stream, child_stream) = Stream::pair()?;
    stream.set_read_timeout(Some(POLL))?;
    let mut command = script_command(target, script)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(child_stream)))
        .stderr(Stdio::null());
    let mut child = ChildGuard(command.spawn()?);
    read_listing(&mut stream, DEADLINE, || {
        matches!(child.0.try_wait(), Ok(Some(_)))
    })
}

/// A host's listing off `stream`, stopping as soon as one has arrived and holding
/// `timeout` as the bound for a host that never prints one. EOF is not the end of
/// one of these channels: a child that wrote three bytes and exited leaves the read
/// waiting, so `gone` says whether the writer has finished, which ends a short or
/// absent listing at once rather than at the deadline.
#[cfg(unix)]
fn read_listing(
    stream: &mut impl Read,
    timeout: Duration,
    gone: impl FnMut() -> bool,
) -> Result<Vec<u8>> {
    let started = Instant::now();
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    let mut gone = gone;
    loop {
        if started.elapsed() >= timeout {
            return Err(Error::SshTimeout);
        }
        match stream.read(&mut buffer) {
            // The child closed its end: the listing is whatever came before, which
            // is also how a host that printed nothing is reported as closed.
            Ok(0) => return Ok(output),
            Ok(read) => {
                output.extend_from_slice(&buffer[..read]);
                if output.len() > MAX_OUTPUT {
                    return Err(Error::SshOutputLimit);
                }
                if listed_sessions(&output) {
                    return Ok(output);
                }
            }
            Err(error) if idle(&error) && gone() => return Ok(output),
            Err(error) if idle(&error) => {}
            Err(error) => return Err(error.into()),
        }
    }
}

/// Whether an error means "nothing to read yet" rather than a broken channel.
#[cfg(unix)]
fn idle(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
    )
}

/// Whether a host has already printed a complete session list, which is the point
/// past which reading more can only wait for an EOF that may never come.
#[cfg(unix)]
fn listed_sessions(output: &[u8]) -> bool {
    output
        .split(|byte| *byte == b'\n')
        .any(|line| serde_json::from_slice::<SessionList>(line).is_ok())
}

/// The bytes a host printed, as sessions. The last line that parses wins, because
/// SSH can put a banner or motd in front of the JSON, and a host that printed no
/// JSON at all is an error rather than a machine with no sessions. Names this
/// client could never attach to are dropped, and more than `LIMIT` sessions is
/// refused rather than truncated. Order is the local listing's: `default` first,
/// then by name.
pub(crate) fn parse_session_list(output: &[u8]) -> Result<Vec<RemoteSession>> {
    // An empty response is the child closing stdout without printing anything:
    // SSH failed, or no candidate ran. It is not a host that has no sessions.
    if output.is_empty() {
        return Err(Error::SshClosed);
    }
    let mut listed = None;
    let mut invalid = None;
    for line in output.split(|byte| *byte == b'\n') {
        match serde_json::from_slice::<SessionList>(line) {
            Ok(list) => listed = Some(list),
            Err(error) => invalid = Some(error),
        }
    }
    let sessions = match (listed, invalid) {
        (Some(list), _) => list.sessions,
        // Report the last failure: the banner is noise, the JSON was the answer.
        (None, Some(error)) => return Err(Error::Json(error)),
        // Unreachable after the empty check: a non-empty output has a line to fail.
        (None, None) => return Err(Error::SshClosed),
    };
    if sessions.len() > LIMIT {
        return Err(Error::SessionLimit);
    }
    let mut sessions: Vec<RemoteSession> = sessions
        .into_iter()
        .filter(|session| valid_session_name(&session.name))
        .collect();
    sessions.sort_by(|a, b| {
        (a.name != DEFAULT, a.name.as_str()).cmp(&(b.name != DEFAULT, b.name.as_str()))
    });
    Ok(sessions)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
