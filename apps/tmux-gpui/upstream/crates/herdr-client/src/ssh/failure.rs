//! Why `ssh` closed the bridge before its ready banner. The child's exit code
//! and a bounded stderr tail are read only to pick a class here; the text is
//! never retained, logged, or shown, since it can name users, keys, and paths.
#[cfg(unix)]
use crate::Result;
#[cfg(unix)]
use std::{
    io::{ErrorKind, Read},
    process::{Child, ChildStderr},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
    time::{Duration, Instant},
};

/// What stopped an SSH bridge before it was ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SshFailure {
    /// The host key is unknown or changed; strict checking refused it.
    #[error("the host key is not trusted; verify it by running ssh to the host in a terminal")]
    HostKey,
    /// No credential was accepted without a prompt.
    #[error(
        "authentication failed; load a key into the agent or open a ControlMaster connection in a terminal"
    )]
    Auth,
    /// The host could not be resolved or reached.
    #[error("the host is unreachable")]
    Unreachable,
    /// No Herdr was found in the known install locations. One that is
    /// installed but cannot serve this client is `Error::BridgeIncompatible`.
    #[error("no Herdr is installed on the host")]
    HerdrMissing,
    /// None of the above could be told from what `ssh` reported.
    #[error("check host trust, authentication, and remote Herdr installation")]
    Other,
}

impl SshFailure {
    /// Whether retrying soon is pointless: the user has to fix something
    /// outside the app first, such as a key, the known hosts, or an install.
    pub fn needs_user(self) -> bool {
        matches!(self, Self::HostKey | Self::Auth | Self::HerdrMissing)
    }

    /// `ssh` exits 255 for its own failures; the bridge script exits 127 when
    /// it found no candidate binary at all. Any other status is the remote's.
    #[cfg(unix)]
    pub(super) fn classify(code: Option<i32>, stderr: &[u8]) -> Self {
        match code {
            Some(127) => Self::HerdrMissing,
            Some(255) => {
                let text = String::from_utf8_lossy(stderr);
                let has = |markers: &[&str]| markers.iter().any(|m| text.contains(m));
                if has(&[
                    "Host key verification failed",
                    "REMOTE HOST IDENTIFICATION HAS CHANGED",
                ]) {
                    Self::HostKey
                } else if has(&["Permission denied", "Too many authentication failures"]) {
                    Self::Auth
                } else if has(&[
                    "Could not resolve hostname",
                    "Connection refused",
                    "timed out",
                    "Network is unreachable",
                    "No route to host",
                    "Connection closed by",
                    "Connection reset",
                ]) {
                    Self::Unreachable
                } else {
                    Self::Other
                }
            }
            _ => Self::Other,
        }
    }
}

/// Bytes of stderr kept for classification. `ssh` reports its failure last.
#[cfg(unix)]
const STDERR_TAIL: usize = 4096;
/// How long a closed bridge may take to exit and finish its stderr.
#[cfg(unix)]
const DIAGNOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// Drain the child's stderr for its whole life, so a chatty remote can never
/// fill the pipe and stall `ssh`, and hand over the tail once it closes.
#[cfg(unix)]
pub(super) fn drain(stderr: ChildStderr) -> Result<Receiver<Vec<u8>>> {
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("herdr-ssh-stderr".into())
        .spawn(move || {
            let _ = tx.send(tail(stderr));
        })?;
    Ok(rx)
}

#[cfg(unix)]
fn tail(mut stderr: impl Read) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        let n = match stderr.read(&mut buffer) {
            Ok(0) => return kept,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return kept,
        };
        kept.extend_from_slice(&buffer[..n]);
        if kept.len() > STDERR_TAIL {
            kept.drain(..kept.len() - STDERR_TAIL);
        }
    }
}

/// Classify a bridge whose stdout closed before it was ready. Waits on the
/// connection worker, at most `DIAGNOSE_TIMEOUT`, for the exit and stderr.
#[cfg(unix)]
pub(super) fn diagnose(
    child: &mut Child,
    stderr: &Receiver<Vec<u8>>,
    stop: &AtomicBool,
) -> SshFailure {
    let deadline = Instant::now() + DIAGNOSE_TIMEOUT;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline && !stop.load(Ordering::Acquire) => {
                thread::sleep(Duration::from_millis(10));
            }
            _ => return SshFailure::Other,
        }
    };
    let stderr = stderr
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .unwrap_or_default();
    SshFailure::classify(code, &stderr)
}

#[cfg(all(test, unix))]
mod tests;
