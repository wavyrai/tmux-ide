//! One-shot POSIX shell scripts on this machine or an SSH host.
//!
//! This exists for work the endpoint connection cannot express, such as Git
//! plumbing in a remote checkout or `herdr` CLI queries whose methods are not
//! advertised to GUI clients. It never touches a daemon connection.
use crate::{Error, Result, catalog::validate_target};
use std::{
    io::{Read, Write},
    sync::atomic::AtomicBool,
    time::Duration,
};

/// Where a script runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptHost<'a> {
    Local,
    /// A validated `[user@]host` target, using the endpoint SSH trust policy.
    Ssh(&'a str),
}

/// Bounds for one script run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScriptLimits {
    /// Maximum stdout bytes accepted before the script is killed.
    pub output: u64,
    /// Longest interval without stdin/stdout/stderr progress.
    pub idle: Duration,
}

/// Quote `value` as one POSIX shell word.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Run `script` with `/bin/sh`, streaming `input` to its stdin and its stdout
/// to `output`. Returns the number of stdout bytes written.
///
/// Blocking: call only on a background worker. Cancellation and limit
/// failures kill the child (an SSH child takes its remote session with it).
/// A failing exit retains a bounded, control-free stderr tail as a diagnostic.
/// Linux and macOS clients only.
pub fn run_script(
    host: ScriptHost<'_>,
    script: &str,
    input: impl Read + Send,
    output: impl Write + Send,
    limits: ScriptLimits,
    cancelled: &AtomicBool,
) -> Result<u64> {
    if let ScriptHost::Ssh(target) = host {
        validate_target(target)?;
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let command = match host {
            ScriptHost::Local => {
                let mut command = std::process::Command::new("/bin/sh");
                command.args(["-c", script]);
                command
            }
            ScriptHost::Ssh(target) => {
                crate::ssh::command(target, &format!("/bin/sh -c {}", shell_quote(script)))
            }
        };
        posix::run(command, input, output, limits, cancelled)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (script, input, output, limits, cancelled);
        Err(Error::ScriptUnsupported)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod posix {
    use super::*;
    use crate::ssh::ChildGuard;
    use std::{
        io::{self, ErrorKind},
        os::unix::process::CommandExt,
        process::{Command, Stdio},
        sync::atomic::{AtomicU64, Ordering},
        thread,
        time::Instant,
    };

    const CHUNK: usize = 65536;
    const POLL: Duration = Duration::from_millis(10);
    /// Bytes of stderr retained for diagnostics; older output is discarded.
    const STDERR_TAIL: usize = 4096;

    fn diagnostic(tail: &[u8]) -> String {
        String::from_utf8_lossy(tail)
            .chars()
            .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
            .collect::<String>()
            .trim()
            .to_owned()
    }

    /// Milliseconds since `start` of the latest I/O on any stream.
    struct Progress {
        start: Instant,
        last: AtomicU64,
    }

    impl Progress {
        fn touch(&self) {
            let now = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);
            self.last.store(now, Ordering::Release);
        }

        fn idle(&self) -> Duration {
            let last = Duration::from_millis(self.last.load(Ordering::Acquire));
            self.start.elapsed().saturating_sub(last)
        }
    }

    fn feed(mut input: impl Read, mut stdin: impl Write, progress: &Progress) -> Result<()> {
        let mut buffer = [0u8; CHUNK];
        loop {
            let n = match input.read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(n) => n,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(Error::ScriptInput(e)),
            };
            match stdin.write_all(&buffer[..n]) {
                Ok(()) => progress.touch(),
                // The script may legitimately exit without reading its input;
                // its exit status decides the outcome.
                Err(e) if e.kind() == ErrorKind::BrokenPipe => return Ok(()),
                Err(e) => return Err(Error::ScriptIo(e)),
            }
        }
    }

    fn drain(
        mut stdout: impl Read,
        mut output: impl Write,
        limit: u64,
        progress: &Progress,
    ) -> Result<u64> {
        let mut buffer = [0u8; CHUNK];
        let mut total = 0u64;
        loop {
            let n = match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(Error::ScriptIo(e)),
            };
            progress.touch();
            total = total.saturating_add(n as u64);
            if total > limit {
                return Err(Error::ScriptOutputLimit);
            }
            output
                .write_all(&buffer[..n])
                .map_err(Error::ScriptOutput)?;
        }
        output.flush().map_err(Error::ScriptOutput)?;
        Ok(total)
    }

    fn tail(mut stderr: impl Read, progress: &Progress) -> io::Result<Vec<u8>> {
        let mut kept = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let n = match stderr.read(&mut buffer) {
                Ok(0) => return Ok(kept),
                Ok(n) => n,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            progress.touch();
            kept.extend_from_slice(&buffer[..n]);
            if kept.len() > STDERR_TAIL {
                kept.drain(..kept.len() - STDERR_TAIL);
            }
        }
    }

    pub(super) fn run(
        mut command: Command,
        input: impl Read + Send,
        output: impl Write + Send,
        limits: ScriptLimits,
        cancelled: &AtomicBool,
    ) -> Result<u64> {
        // A fresh process group holds only this script and its descendants, so
        // stopping it can reach children that would otherwise keep the output
        // pipes open, and a terminal's signals never reach it.
        command
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Dropping the guard kills and reaps the child on every early return.
        let mut child = ChildGuard(command.spawn().map_err(Error::ScriptSpawn)?);
        let group = rustix::process::Pid::from_child(&child.0);
        let (Some(stdin), Some(stdout), Some(stderr)) = (
            child.0.stdin.take(),
            child.0.stdout.take(),
            child.0.stderr.take(),
        ) else {
            return Err(Error::ScriptIo(ErrorKind::BrokenPipe.into()));
        };
        let progress = Progress {
            start: Instant::now(),
            last: AtomicU64::new(0),
        };
        let failed = AtomicBool::new(false);
        let watch = |result: Result<u64>| {
            if result.is_err() {
                failed.store(true, Ordering::Release);
            }
            result
        };
        thread::scope(|scope| {
            let feeder = scope.spawn(|| watch(feed(input, stdin, &progress).map(|()| 0)));
            let drainer = scope.spawn(|| watch(drain(stdout, output, limits.output, &progress)));
            let stderr = scope.spawn(|| tail(stderr, &progress));
            let stopped = loop {
                if cancelled.load(Ordering::Acquire) {
                    break Some(Error::ScriptCancelled);
                }
                if failed.load(Ordering::Acquire) {
                    // The worker's own error is reported after joining.
                    break None;
                }
                if progress.idle() >= limits.idle {
                    break Some(Error::ScriptTimeout);
                }
                if child.0.try_wait().map_err(Error::ScriptIo)?.is_some() {
                    break None;
                }
                thread::sleep(POLL);
            };
            if stopped.is_some() || failed.load(Ordering::Acquire) {
                let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
                let _ = child.0.kill();
            }
            // Pipes close once the child is gone, so every worker terminates.
            let status = child.0.wait().map_err(Error::ScriptIo)?;
            let fed = feeder.join().map_err(|_| Error::ScriptWorker)?;
            let drained = drainer.join().map_err(|_| Error::ScriptWorker)?;
            let stderr = stderr.join().map_err(|_| Error::ScriptWorker)?;
            if let Some(error) = stopped {
                return Err(error);
            }
            fed?;
            let written = drained?;
            if !status.success() {
                return Err(Error::ScriptExit {
                    status,
                    stderr: diagnostic(&stderr.unwrap_or_default()),
                });
            }
            Ok(written)
        })
    }

    #[cfg(test)]
    #[allow(clippy::unwrap_used, clippy::expect_used)]
    mod tests {
        include!("script_tests.rs");
    }
}
