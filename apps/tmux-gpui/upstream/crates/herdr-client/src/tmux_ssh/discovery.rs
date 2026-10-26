//! Blocking worker-only discovery. Both pipes are nonblocking and drained with a
//! per-turn budget; inherited pipe writers cannot outlive the operation deadline.
use super::{RemoteDescriptor, SshTarget, discovery_command};
use std::{
    io::{self, Read},
    os::fd::AsFd,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("SSH discovery was cancelled")]
    Cancelled,
    #[error("SSH discovery timed out")]
    Timeout,
    #[error("SSH discovery output exceeds its limit")]
    OutputLimit,
    #[error("Remote tmux-ide CLI is missing")]
    MissingCli,
    #[error("SSH host key verification failed")]
    HostKey,
    #[error("SSH authentication failed")]
    Authentication,
    #[error("SSH discovery failed")]
    Exit,
    #[error("SSH discovery I/O failed")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Descriptor(#[from] super::Error),
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Run on a background worker, never the UI thread. A descriptor is still not
/// proof that a later forwarded TCP connection belongs to this daemon.
pub fn discover(
    target: &SshTarget,
    expected_environment: Option<&str>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<RemoteDescriptor, DiscoveryError> {
    let bytes = execute(discovery_command(target), cancelled, deadline)?;
    Ok(RemoteDescriptor::parse(&bytes, expected_environment)?)
}

pub(super) fn nonblocking(fd: &impl AsFd) -> io::Result<()> {
    let flags = rustix::fs::fcntl_getfl(fd)?;
    Ok(rustix::fs::fcntl_setfl(
        fd,
        flags | rustix::fs::OFlags::NONBLOCK,
    )?)
}

fn check(cancelled: &AtomicBool, deadline: Instant) -> Result<(), DiscoveryError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(DiscoveryError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(DiscoveryError::Timeout);
    }
    Ok(())
}

fn execute(
    mut command: Command,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<u8>, DiscoveryError> {
    check(cancelled, deadline)?;
    let mut child = OwnedChild(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let mut stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing stdout"))?;
    let mut stderr = child
        .0
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("missing stderr"))?;
    nonblocking(&stdout)?;
    nonblocking(&stderr)?;
    let mut bytes = Vec::new();
    let mut output_done = false;
    let mut error_done = false;
    let mut status = None;
    let mut diagnostics = Diagnostics::default();
    loop {
        check(cancelled, deadline)?;
        if !output_done {
            output_done = drain(&mut stdout, |chunk| {
                if bytes.len() + chunk.len() > 32 * 1024 {
                    return Err(DiscoveryError::OutputLimit);
                }
                bytes.extend_from_slice(chunk);
                Ok(())
            })?;
        }
        if !error_done {
            error_done = drain(&mut stderr, |chunk| {
                diagnostics.observe(chunk);
                Ok(())
            })?;
        }
        if status.is_none() {
            status = child.0.try_wait()?;
        }
        if let Some(status) = status {
            if !status.success() {
                return Err(if status.code() == Some(127) {
                    DiscoveryError::MissingCli
                } else {
                    diagnostics.failure()
                });
            }
            if output_done && error_done {
                return Ok(bytes);
            }
        }
        thread::sleep(
            Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[derive(Default)]
pub(super) struct Diagnostics {
    tail: Vec<u8>,
    host_key: bool,
    authentication: bool,
}
impl Diagnostics {
    pub(super) fn observe(&mut self, bytes: &[u8]) {
        self.tail.extend_from_slice(bytes);
        if self.tail.len() > 4096 {
            self.tail.drain(..self.tail.len() - 4096);
        }
        let text = String::from_utf8_lossy(&self.tail).to_ascii_lowercase();
        self.host_key |= text.contains("host key verification failed")
            || text.contains("remote host identification has changed");
        self.authentication |= ["publickey", "password", "keyboard-interactive"]
            .iter()
            .any(|method| text.contains(&format!("permission denied ({method}")));
    }
    pub(super) fn failure(&self) -> DiscoveryError {
        if self.host_key {
            DiscoveryError::HostKey
        } else if self.authentication {
            DiscoveryError::Authentication
        } else {
            DiscoveryError::Exit
        }
    }
}

fn drain(
    reader: &mut impl Read,
    mut observe: impl FnMut(&[u8]) -> Result<(), DiscoveryError>,
) -> Result<bool, DiscoveryError> {
    let mut buffer = [0; 4096];
    for _ in 0..8 {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(count) => observe(&buffer[..count])?,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(false)
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod tests;
