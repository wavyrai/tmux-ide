//! Own the metadata broker directly, without a second Node supervisor process.
//! Spawning happens before the UI starts; retirement and reaping run on a worker.
use std::{
    ffi::OsStr,
    io,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const POLL: Duration = Duration::from_millis(25);
const GRACE: Duration = Duration::from_millis(1500);

/// Keep this alive for the window's lifetime. Dropping it never waits on the UI.
pub struct Owner {
    _stop: Sender<()>,
    _worker: JoinHandle<()>,
}

impl Owner {
    /// Complete retirement after the UI event loop returns, before process exit.
    /// Never call this on an active UI thread: cleanup has a bounded grace period.
    pub fn shutdown(self) -> io::Result<()> {
        drop(self._stop);
        self._worker
            .join()
            .map_err(|_| io::Error::other("broker owner panicked"))
    }
}

pub struct Broker {
    pub reader: ChildStdout,
    pub writer: ChildStdin,
    pub owner: Owner,
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Use the packaged Node and broker paths, with no shell or inherited Node hooks.
pub fn spawn(node: &OsStr, script: &OsStr, host: &OsStr) -> io::Result<Broker> {
    let mut command = Command::new(node);
    command
        .args([script, host])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("TMUX_IDE_GUI_NATIVE_ENCODING", "binary-rle-v1")
        .env("TMUX_IDE_GUI_HELPER_ENCODING", "legacy");
    spawn_command(command)
}

fn spawn_command(mut command: Command) -> io::Result<Broker> {
    let mut child = OwnedChild(
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    let reader = child
        .0
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("broker stdout missing"))?;
    let writer = child
        .0
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("broker stdin missing"))?;
    let (stop, stopped) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("tmux-broker-owner".into())
        .spawn(move || {
            loop {
                match child.0.try_wait() {
                    Ok(Some(_)) | Err(_) => return,
                    Ok(None) => {}
                }
                match stopped.recv_timeout(POLL) {
                    Err(RecvTimeoutError::Timeout) => continue,
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            // Node's SIGTERM handler closes discovery and SSH resources. Only this
            // owned, unreaped PID can be signalled; never target a process group.
            #[cfg(unix)]
            if let Ok(pid) = i32::try_from(child.0.id())
                && let Some(pid) = rustix::process::Pid::from_raw(pid)
            {
                let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
            }
            let deadline = Instant::now() + GRACE;
            while Instant::now() < deadline {
                match child.0.try_wait() {
                    Ok(Some(_)) | Err(_) => return,
                    Ok(None) => thread::sleep(POLL),
                }
            }
            // OwnedChild escalates and reaps a broker that did not finish cleanup.
        })?;
    Ok(Broker {
        reader,
        writer,
        owner: Owner {
            _stop: stop,
            _worker: worker,
        },
    })
}

#[cfg(all(test, unix))]
#[path = "tmux_broker_process_tests.rs"]
mod tests;
