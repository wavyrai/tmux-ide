//! POSIX discovery/stdio bridge adapted from upstream remote/attach.rs.
//! No installers, daemon restarts, SSH config edits, or trust-on-first-use.
//! The remote host is always POSIX; the local half needs a socket pair it can
//! hand to the `ssh` child as its standard streams, which only Unix provides.
//! The bridge and probe scripts, and the handshake that reads them, are shared
//! with WSL distributions, which run the same scripts through `wsl.exe`.
#[cfg(unix)]
use crate::limits::POLL;
use crate::{Error, Result, catalog::validate_target, session_socket, transport::Stream};
#[cfg(unix)]
use std::os::fd::OwnedFd;
use std::{
    io::{self, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

mod failure;
pub use failure::SshFailure;

const READY: &[u8] = b"herdr-remote-output-ready:1\n";

/// A bridge, probe, or script child (`ssh`, or `wsl.exe` on Windows), killed
/// and reaped on every exit path.
pub(crate) struct ChildGuard(pub(crate) Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub(super) use crate::script::shell_quote as quote;

// PATH first, excluding mise shims, followed by upstream's known install roots.
// Keep paths in shell variables: discovered executable names are never eval'd.
pub(super) const CANDIDATES: &str = r#"candidate=$(command -v herdr 2>/dev/null || :)
case "$candidate" in /*/mise/shims/herdr) candidate=;; /*) ;; *) candidate=;; esac
for path in "$candidate" "$HOME/.local/bin/herdr" /opt/homebrew/bin/herdr /usr/local/bin/herdr /home/linuxbrew/.linuxbrew/bin/herdr "$HOME/.nix-profile/bin/herdr" "/etc/profiles/per-user/$USER/bin/herdr" /nix/var/nix/profiles/default/bin/herdr /run/current-system/sw/bin/herdr; do"#;

const PROBE_CANDIDATE: &str = "herdr-probe:candidate";
const PROBE_DONE: &str = "herdr-probe:done";
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_OUTPUT_LIMIT: u64 = 64 * 1024;

#[cfg(unix)]
fn bridge_command(session: &str) -> String {
    format!("/bin/sh -c {}", quote(&bridge_script(session)))
}

/// The bridge as a script for `/bin/sh -c`: report each candidate's client
/// status, then run whichever one the handshake accepts.
pub(crate) fn bridge_script(session: &str) -> String {
    format!(
        r#"{CANDIDATES}
    if [ -n "$path" ] && [ -x "$path" ]; then
        status=$("$path" status client --json </dev/null) || continue
        printf '%s\n' "$status"
        printf '\n%s\n' 'herdr-remote-output-ready:1'
        IFS= read -r choice || exit 1
        case "$choice" in
            accept) exec "$path" --session {session} remote-client-bridge;;
            accept-idle) exec "$path" --session {session} remote-client-bridge --idle-timeout-v1;;
        esac
    fi
done
exit 127"#,
        session = quote(session)
    )
}

/// What a remote host offers for a saved SSH device, learned without
/// installing, upgrading, or starting anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostProbe {
    /// SSH could not run a command without prompting: unknown host key,
    /// password or passphrase authentication, or an unreachable host.
    SshFailed,
    /// No Herdr executable was found in the known install locations.
    Missing,
    /// Herdr is installed, but no copy speaks this client's endpoint protocol.
    Outdated,
    /// A compatible Herdr is installed and its server for the session is down.
    Stopped,
    /// A compatible Herdr server for the session is running.
    Running,
}

/// Every candidate reports its client and server status, one block each, so
/// the choice between them stays with the same rules the bridge applies.
#[cfg(unix)]
fn probe_command(session: &str) -> String {
    format!("/bin/sh -c {}", quote(&probe_script(session)))
}

/// The probe as a script for `/bin/sh -c`.
pub(crate) fn probe_script(session: &str) -> String {
    format!(
        r#"{CANDIDATES}
    if [ -n "$path" ] && [ -x "$path" ]; then
        status=$("$path" status client --json </dev/null) || continue
        server=$("$path" --session {session} status server --json </dev/null) || server=
        printf '%s\n%s\n%s\n' '{PROBE_CANDIDATE}' "$status" "$server"
    fi
done
printf '%s\n' '{PROBE_DONE}'"#,
        session = quote(session)
    )
}

/// `None` when the script never finished, so partial output is not mistaken
/// for a host without Herdr.
pub(crate) fn classify_probe(output: &[u8]) -> Option<HostProbe> {
    // Each block holds one candidate's client status, then its server status.
    let mut blocks: Vec<Vec<serde_json::Value>> = Vec::new();
    for line in output.split(|b| *b == b'\n') {
        if line == PROBE_DONE.as_bytes() {
            let Some(statuses) = blocks
                .iter()
                .find(|statuses| statuses.iter().any(|s| compatible(s).is_some()))
            else {
                return Some(if blocks.is_empty() {
                    HostProbe::Missing
                } else {
                    HostProbe::Outdated
                });
            };
            let running = statuses
                .iter()
                .any(|s| s["running"].as_bool() == Some(true));
            return Some(if running {
                HostProbe::Running
            } else {
                HostProbe::Stopped
            });
        }
        if line == PROBE_CANDIDATE.as_bytes() {
            blocks.push(Vec::new());
        } else if let (Some(block), Ok(status)) = (blocks.last_mut(), serde_json::from_slice(line))
        {
            block.push(status);
        }
    }
    None
}

/// Blocks for at most `PROBE_TIMEOUT`: call it from a background thread.
#[cfg(unix)]
pub fn probe_host(target: &str, session: &str) -> Result<HostProbe> {
    validate_target(target)?;
    session_socket(Path::new(""), session)?;
    let (status, output) = run_remote(target, &probe_command(session), PROBE_TIMEOUT, || false)?;
    if status.code() == Some(255) {
        return Ok(HostProbe::SshFailed);
    }
    classify_probe(&output).ok_or(Error::SshClosed)
}

/// The `remote.origin.url` of a repository on a saved host, read without a
/// prompt. `git_dir` is the absolute Git directory the daemon reported for the
/// workspace. `None` when the repository has no origin remote. Blocks for at
/// most `timeout`: call it from a background thread.
#[cfg(unix)]
pub fn remote_origin_url(
    target: &str,
    git_dir: &str,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<Option<String>> {
    remote_config_value(target, git_dir, "remote.origin.url", timeout, cancelled)
}

/// Read one Git configuration value on a saved host using bounded,
/// noninteractive SSH. Call only from a background thread.
#[cfg(unix)]
pub fn remote_config_value(
    target: &str,
    git_dir: &str,
    key: &str,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<Option<String>> {
    validate_target(target)?;
    if !git_dir.starts_with('/') || git_dir.chars().any(char::is_control) {
        return Err(Error::InvalidGitDir);
    }
    let (status, output) = run_remote(target, &config_command(git_dir, key), timeout, cancelled)?;
    match status.code() {
        Some(0) => {}
        // `git config --get` exits 1 when the key is absent.
        Some(1) => return Ok(None),
        _ => return Err(Error::RemoteCommand(status)),
    }
    let value = String::from_utf8(output).map_err(|_| Error::RemoteOutput)?;
    let value = value.trim_end_matches(['\r', '\n']);
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(Error::RemoteOutput);
    }
    Ok(Some(value.to_owned()))
}

#[cfg(unix)]
fn config_command(git_dir: &str, key: &str) -> String {
    let script = format!(
        "exec git -c core.fsmonitor=false --git-dir {} config --get -- {}",
        quote(git_dir),
        quote(key)
    );
    format!("/bin/sh -c {}", quote(&script))
}

/// Where an SSH target connects, as the local SSH configuration resolves it.
/// Different spellings of one host (an alias, `user@address`, `ssh://`, or a
/// config-supplied user or port) resolve to the same value.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Destination {
    pub user: String,
    pub host: String,
    pub port: u16,
}

/// Resolve `target` with `ssh -G`, which reads configuration only and never
/// connects. Blocks briefly: call it from a background thread.
#[cfg(unix)]
pub fn resolve_destination(target: &str) -> Result<Destination> {
    validate_target(target)?;
    let mut command = Command::new("ssh");
    command.args(["-G", "--", target]);
    let (status, output) = run(&mut command, Duration::from_secs(5), || false)?;
    if !status.success() {
        return Err(Error::RemoteCommand(status));
    }
    parse_destination(&output).ok_or(Error::RemoteOutput)
}

#[cfg(windows)]
pub fn resolve_destination(target: &str) -> Result<Destination> {
    validate_target(target)?;
    Err(Error::SshUnsupported)
}

#[cfg(unix)]
fn parse_destination(output: &[u8]) -> Option<Destination> {
    let text = std::str::from_utf8(output).ok()?;
    let value = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix(' '))
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    Some(Destination {
        user: value("user")?.to_owned(),
        // Host names are case-insensitive; addresses are unaffected.
        host: value("hostname")?.to_ascii_lowercase(),
        port: value("port")?.parse().ok()?,
    })
}

/// Runs one noninteractive SSH command, keeping at most `PROBE_OUTPUT_LIMIT`
/// bytes of stdout and never stderr, which can carry banners or secrets.
#[cfg(unix)]
fn run_remote(
    target: &str,
    remote_command: &str,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<(std::process::ExitStatus, Vec<u8>)> {
    run(&mut command(target, remote_command), timeout, cancelled)
}

/// Runs `command` with a deadline, keeping at most `PROBE_OUTPUT_LIMIT` bytes
/// of stdout and discarding stderr.
pub(crate) fn run(
    command: &mut Command,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<(std::process::ExitStatus, Vec<u8>)> {
    let mut child = ChildGuard(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?,
    );
    let stdout = child.0.stdout.take().ok_or(Error::SshClosed)?;
    // The pipe reaches EOF once the child exits or the guard kills it.
    let reader = std::thread::Builder::new()
        .name("herdr-ssh-command".into())
        .spawn(move || {
            let mut output = Vec::new();
            stdout
                .take(PROBE_OUTPUT_LIMIT + 1)
                .read_to_end(&mut output)
                .map(|_| output)
        })?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.0.try_wait()? {
            break status;
        }
        if cancelled() {
            return Err(Error::SshCancelled);
        }
        if Instant::now() >= deadline {
            return Err(Error::SshTimeout);
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let output = reader.join().map_err(|_| Error::SshClosed)??;
    if output.len() as u64 > PROBE_OUTPUT_LIMIT {
        return Err(Error::SshOutputLimit);
    }
    Ok((status, output))
}

#[cfg(windows)]
pub fn probe_host(target: &str, session: &str) -> Result<HostProbe> {
    validate_target(target)?;
    session_socket(Path::new(""), session)?;
    Err(Error::SshUnsupported)
}

#[cfg(windows)]
pub fn remote_origin_url(
    target: &str,
    _git_dir: &str,
    _timeout: Duration,
    _cancelled: impl Fn() -> bool,
) -> Result<Option<String>> {
    validate_target(target)?;
    Err(Error::SshUnsupported)
}

#[cfg(windows)]
pub fn remote_config_value(
    target: &str,
    _git_dir: &str,
    _key: &str,
    _timeout: Duration,
    _cancelled: impl Fn() -> bool,
) -> Result<Option<String>> {
    validate_target(target)?;
    Err(Error::SshUnsupported)
}

/// Agent forwarding and connection sharing follow the user's SSH config, as
/// upstream's client does. `ForwardAgent yes` lets the remote bridge register
/// the forwarded agent with the daemon, so remote panes keep a working
/// `SSH_AUTH_SOCK` across reconnects. A configured `ControlPath` lets a master
/// the user authenticated interactively (MFA, passwords) carry these
/// noninteractive connections. `ControlMaster=no` still forbids this child from
/// becoming a master: killing it must never end the user's other sessions, and
/// it must not leave a persistent background process behind.
#[cfg(unix)]
pub(super) fn command(target: &str, remote_command: &str) -> Command {
    let mut command = noninteractive();
    command.args(["-o", "ClearAllForwardings=yes", "--", target]);
    command.arg(remote_command);
    command
}

/// `ssh` with the bridge's connection policy and nothing to connect yet.
#[cfg(unix)]
fn noninteractive() -> Command {
    let mut command = Command::new("ssh");
    command.args([
        "-T",
        "-C",
        "-o",
        "BatchMode=yes",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "ForwardX11=no",
        "-o",
        "ControlMaster=no",
    ]);
    command
}

/// The line a [`forward_command`] child prints on stdout once its forward is
/// bound.
pub const FORWARD_READY: &str = "herdr-forward-ready";

/// A noninteractive `ssh` child that runs no remote command and forwards
/// `127.0.0.1:<local>` on this machine to `localhost:<remote>` on `target`,
/// so a server listening only on the remote host's loopback can be opened
/// here. Forwarding is this child's whole purpose, so unlike the bridge it
/// keeps forwardings.
///
/// Readiness comes from SSH itself, never from connecting to the port, which
/// another local process could have bound first: `ExitOnForwardFailure` ends
/// the child when the bind fails, and OpenSSH runs `LocalCommand` only after
/// its forwards are set up, so [`FORWARD_READY`] on stdout means this child
/// holds the port. `ControlPath=none` keeps the forward in this child rather
/// than in a shared master, so killing the child closes it; a host that needs
/// an interactively authenticated master cannot be tunnelled. The caller owns
/// the child: its streams, readiness, and reaping.
#[cfg(unix)]
pub fn forward_command(target: &str, local: u16, remote: u16) -> Result<Command> {
    validate_target(target)?;
    let mut command = noninteractive();
    command.args([
        "-N",
        "-o",
        "ControlPath=none",
        "-o",
        "PermitLocalCommand=yes",
        "-o",
        &format!("LocalCommand=echo {FORWARD_READY}"),
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        &format!("127.0.0.1:{local}:localhost:{remote}"),
        "--",
        target,
    ]);
    Ok(command)
}

/// Windows rejects SSH endpoints, so it has no host to forward from.
#[cfg(windows)]
pub fn forward_command(target: &str, _local: u16, _remote: u16) -> Result<Command> {
    validate_target(target)?;
    Err(Error::SshUnsupported)
}

/// A one-shot, noninteractive `ssh` child that runs `script` under the remote
/// `/bin/sh`, whatever the login shell, with the bridge's connection policy.
/// The caller owns the child: its streams, deadline, and reaping.
#[cfg(unix)]
pub fn script_command(target: &str, script: &str) -> Result<Command> {
    validate_target(target)?;
    Ok(command(target, &format!("/bin/sh -c {}", quote(script))))
}

#[cfg(unix)]
pub(crate) fn connect(
    target: &str,
    session: &str,
    stop: &AtomicBool,
) -> Result<(Stream, ChildGuard)> {
    validate_target(target)?;
    session_socket(Path::new(""), session)?;
    bridge(command(target, &bridge_command(session)), stop)
}

/// The stdio bridge through an application-built remote command, such as
/// `coder ssh -- <workspace>`: the discovery script is appended as its final
/// argument, and the command's standard streams become the connection. The
/// caller owns the program, its arguments, and any credential it needs.
#[cfg(unix)]
pub fn connect_command(mut command: Command, session: &str, stop: &AtomicBool) -> Result<Bridge> {
    session_socket(Path::new(""), session)?;
    command.arg(bridge_command(session));
    let (stream, child) = bridge(command, stop)?;
    Ok(Bridge { stream, child })
}

#[cfg(windows)]
pub fn connect_command(_command: Command, session: &str, _stop: &AtomicBool) -> Result<Bridge> {
    session_socket(Path::new(""), session)?;
    Err(Error::SshUnsupported)
}

/// A spawned remote bridge that has answered discovery. Dropping it kills and
/// reaps the child.
pub struct Bridge {
    pub(crate) stream: Stream,
    pub(crate) child: ChildGuard,
}

#[cfg(unix)]
fn bridge(mut command: Command, stop: &AtomicBool) -> Result<(Stream, ChildGuard)> {
    let (mut stream, child_stream) = Stream::pair()?;
    stream.set_read_timeout(Some(POLL))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    command
        .stdin(Stdio::from(OwnedFd::from(child_stream.try_clone()?)))
        .stdout(Stdio::from(OwnedFd::from(child_stream)))
        // Never inherit a GUI terminal. The tail is read only to classify a
        // failed start, then dropped; see `failure`.
        .stderr(Stdio::piped());
    let mut child = ChildGuard(command.spawn()?);
    let stderr = match child.0.stderr.take() {
        Some(stderr) => failure::drain(stderr)?,
        None => return Err(Error::SshClosed),
    };
    match handshake(&mut stream, stop) {
        // Every other way the bridge can close already says why; this one is
        // read from what `ssh` reported.
        Err(Error::SshClosed) => Err(Error::SshRefused(failure::diagnose(
            &mut child.0,
            &stderr,
            stop,
        ))),
        result => result.map(|()| (stream, child)),
    }
}

/// Answer the bridge script: skip each incompatible candidate it reports and
/// accept the first compatible one, which then becomes the client stream.
/// When every candidate was skipped, the script exits and the first refusal
/// says why, instead of the closed bridge every other failure also ends in.
pub(crate) fn handshake(stream: &mut (impl Read + Write), stop: &AtomicBool) -> Result<()> {
    let started = Instant::now();
    let mut refused = None;
    loop {
        let status = match await_ready(stream, stop, started) {
            Err(Error::SshClosed) => return Err(refused.unwrap_or(Error::SshClosed)),
            result => result?,
        };
        if let Some(idle_timeout) = compatible_status(&status) {
            stream.write_all(if idle_timeout {
                b"accept-idle\n"
            } else {
                b"accept\n"
            })?;
            return Ok(());
        }
        refused = refused.or_else(|| incompatible_status(&status));
        stream.write_all(b"skip\n")?;
    }
}

/// Why a candidate's `status client --json` was skipped, if it reported one.
fn incompatible_status(output: &[u8]) -> Option<Error> {
    let status = output
        .split(|b| *b == b'\n')
        .find_map(|line| serde_json::from_slice::<serde_json::Value>(line).ok())?;
    Some(Error::BridgeIncompatible {
        generation: status["endpoint_protocol_generation"]
            .as_u64()
            .and_then(|generation| u32::try_from(generation).ok()),
        version: status["version"].as_str().and_then(crate::compat::label),
    })
}

/// Windows rejects SSH endpoints before spawning anything: saved SSH hosts are
/// not offered there yet (WSL distributions are, through `crate::wsl`).
/// Validation still runs first so a malformed target reports the same error
/// everywhere.
#[cfg(windows)]
pub(crate) fn connect(
    target: &str,
    session: &str,
    _stop: &AtomicBool,
) -> Result<(Stream, ChildGuard)> {
    validate_target(target)?;
    session_socket(Path::new(""), session)?;
    Err(Error::SshUnsupported)
}

fn compatible_status(output: &[u8]) -> Option<bool> {
    output
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice::<serde_json::Value>(line).ok())
        .find_map(|status| compatible(&status))
}

/// Whether one `status client --json` object can serve as this client's
/// bridge, and if so whether it supports the idle timeout.
fn compatible(status: &serde_json::Value) -> Option<bool> {
    if status["endpoint_protocol_generation"].as_u64() != Some(1) {
        return None;
    }
    let capabilities = status["endpoint_capabilities"].as_array()?;
    if ![
        "surface_interest",
        "presentation_effects_fence",
        "health_check",
    ]
    .iter()
    .all(|required| capabilities.iter().any(|c| c.as_str() == Some(required)))
    {
        return None;
    }
    Some(
        status["remote_bridge_idle_timeout"]
            .as_bool()
            .unwrap_or(false),
    )
}

/// Read the bridge's banner until the ready line, returning what preceded it.
/// Takes only `Read`: the SSH child's pipe is a `UnixStream`, but the limit,
/// cancellation and timeout rules here are stream-independent and tested so.
fn await_ready(
    stream: &mut (impl Read + ?Sized),
    stop: &AtomicBool,
    started: Instant,
) -> Result<Vec<u8>> {
    let mut line = Vec::new();
    let mut output = Vec::new();
    let mut total = 0;
    loop {
        if stop.load(Ordering::Acquire) {
            return Err(Error::SshCancelled);
        }
        if started.elapsed() >= Duration::from_secs(15) {
            return Err(Error::SshTimeout);
        }
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => {
                return Err(Error::SshClosed);
            }
            Ok(_) => {
                total += 1;
                if total > 16384 {
                    return Err(Error::SshOutputLimit);
                }
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    if line == READY {
                        return Ok(output);
                    }
                    output.extend_from_slice(&line);
                    line.clear();
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(e.into()),
        }
    }
}

// The bridge is POSIX-only; its fixtures spawn real shells over a socket pair.
#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)] // Test fixtures only.
mod tests;

// Windows never spawns the bridge, but a rejected SSH endpoint must still be
// rejected for the same reasons and in the same order as on POSIX.
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn invalid_targets_and_sessions_are_rejected_before_the_platform_refusal() {
        let stop = AtomicBool::new(false);
        assert!(matches!(
            connect("-oProxyCommand=x", "default", &stop),
            Err(Error::InvalidSshTarget)
        ));
        assert!(matches!(
            connect("host", "../escape", &stop),
            Err(Error::InvalidSession)
        ));
        assert!(matches!(
            connect("host", "default", &stop),
            Err(Error::SshUnsupported)
        ));
    }
}
