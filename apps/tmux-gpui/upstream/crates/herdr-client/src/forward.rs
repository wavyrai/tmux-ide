//! Local forwards of a saved SSH host's listening ports. A worker thread owns
//! one `ssh -N` master per forward, private to that forward, and asks it for
//! the local listener with `ssh -O forward -L`. That request succeeds only once
//! this master itself holds the port, so a forward is never reported for a
//! port some other local process took first. Nothing reconnects; a forward
//! that ends stays ended until someone starts it again. Callers name the
//! remote port, so this knows nothing of how that port was found.
use crate::{Error, Result, catalog::validate_target};
use std::num::NonZeroU16;
#[cfg(unix)]
use std::{
    fs::DirBuilder,
    net::{Ipv4Addr, TcpListener},
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

/// What a forward's worker reports: at most one `Listening`, then at most one
/// `Ended`. A forward stopped by its owner reports nothing more.
#[derive(Debug)]
pub enum ForwardEvent {
    /// This forward's own SSH listens on `127.0.0.1:<local_port>`.
    Listening { local_port: u16 },
    /// SSH exited, or never listened; it has been killed and reaped.
    Ended(Error),
}

/// The local port tried first for `remote`: the same number, except that a
/// privileged port moves up by 10000 (80 becomes 10080) so no local privilege
/// is needed. Orca's port forwarding remaps the same way.
pub fn preferred_local_port(remote: NonZeroU16) -> u16 {
    match remote.get() {
        port @ ..1024 => port + 10000,
        port => port,
    }
}

/// SSH connects within `ConnectTimeout` and authenticates without prompting,
/// so a master that has not opened its control socket by now never will.
#[cfg(unix)]
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Asking a running master for a listener is local and quick.
#[cfg(unix)]
const FORWARD_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(unix)]
const STARTING_POLL: Duration = Duration::from_millis(50);
#[cfg(unix)]
const LISTENING_POLL: Duration = Duration::from_millis(250);

/// The master, shared so its owner can kill it at once while the worker
/// alone waits for it. Neither side holds the lock across a blocking call.
#[cfg(unix)]
#[derive(Default)]
struct Slot {
    stopped: bool,
    child: Option<Child>,
}

#[cfg(unix)]
fn lock(slot: &Mutex<Slot>) -> MutexGuard<'_, Slot> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One running forward. Dropping it stops the forward.
#[cfg(unix)]
pub struct PortForward {
    slot: Arc<Mutex<Slot>>,
    events: mpsc::Receiver<ForwardEvent>,
}

/// No SSH child is ever spawned on Windows, so this type has no values.
#[cfg(windows)]
pub enum PortForward {}

#[cfg(unix)]
impl PortForward {
    /// Forwards `remote_port` on `target`'s loopback to a local port. Returns
    /// at once: running SSH and choosing the port happen on a worker thread.
    pub fn start(target: &str, remote_port: NonZeroU16) -> Result<Self> {
        validate_target(target)?;
        let (master_target, forward_target) = (target.to_owned(), target.to_owned());
        Self::start_with(
            remote_port,
            READY_TIMEOUT,
            move |socket| master_command(&master_target, socket),
            move |socket, local_port| {
                forward_command(&forward_target, socket, local_port, remote_port.get())
            },
        )
    }

    fn start_with(
        remote_port: NonZeroU16,
        ready_timeout: Duration,
        master: impl FnOnce(&Path) -> Command + Send + 'static,
        forward: impl Fn(&Path, u16) -> Command + Send + 'static,
    ) -> Result<Self> {
        let slot = Arc::new(Mutex::new(Slot::default()));
        // Two events at most, so the worker never blocks on a slow owner.
        let (sender, events) = mpsc::sync_channel(2);
        let shared = slot.clone();
        thread::Builder::new()
            .name("herdr-port-forward".into())
            .spawn(move || {
                let result = run(
                    &shared,
                    remote_port,
                    ready_timeout,
                    master,
                    forward,
                    &sender,
                );
                if let Err(error) = result {
                    let _ = sender.try_send(ForwardEvent::Ended(error));
                }
            })?;
        Ok(Self { slot, events })
    }

    /// The worker's next report, without waiting.
    pub fn try_event(&self) -> Option<ForwardEvent> {
        self.events.try_recv().ok()
    }

    /// Kills the master without waiting for it; the worker reaps it. Safe on
    /// the UI thread and while quitting, when the worker may never run again.
    pub fn stop(&self) {
        let mut slot = lock(&self.slot);
        slot.stopped = true;
        if let Some(child) = &mut slot.child {
            // A child the worker already reaped is not signalled again.
            let _ = child.kill();
        }
    }
}

#[cfg(unix)]
impl Drop for PortForward {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
impl PortForward {
    pub fn start(target: &str, _remote_port: NonZeroU16) -> Result<Self> {
        validate_target(target)?;
        Err(Error::SshUnsupported)
    }

    pub fn try_event(&self) -> Option<ForwardEvent> {
        match *self {}
    }

    pub fn stop(&self) {
        match *self {}
    }
}

/// A fresh owner-only directory for one master's control socket, removed
/// with everything in it once the master is reaped. Creation fails rather
/// than reuse anything already at the path.
#[cfg(unix)]
struct ControlDir(PathBuf);

#[cfg(unix)]
impl ControlDir {
    fn create() -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let name = format!(
            "herdr-fwd-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let path = Self::place(&std::env::temp_dir(), &name);
        DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(Error::ForwardControl)?;
        Ok(Self(path))
    }

    /// Where to create the directory `name`: the temporary directory,
    /// unless the socket SSH binds there would not fit. SSH binds it under a
    /// 17-byte random suffix first, and Unix socket paths are limited to 104
    /// bytes on macOS (108 on Linux).
    fn place(temp: &Path, name: &str) -> PathBuf {
        let path = temp.join(name);
        if path.join("c").as_os_str().len() + 17 < 104 {
            path
        } else {
            Path::new("/tmp").join(name)
        }
    }
}

#[cfg(unix)]
impl Drop for ControlDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
enum Master {
    Running,
    Stopped,
    Ended(Error),
}

#[cfg(unix)]
fn master(slot: &Mutex<Slot>) -> Master {
    let mut slot = lock(slot);
    let Slot { stopped, child } = &mut *slot;
    match child {
        Some(child) if !*stopped => match child.try_wait() {
            Ok(None) => Master::Running,
            Ok(Some(status)) => Master::Ended(Error::ForwardExit(status)),
            Err(error) => Master::Ended(Error::Io(error)),
        },
        _ => Master::Stopped,
    }
}

#[cfg(unix)]
fn run(
    slot: &Mutex<Slot>,
    remote_port: NonZeroU16,
    ready_timeout: Duration,
    master_command: impl FnOnce(&Path) -> Command,
    forward_command: impl Fn(&Path, u16) -> Command,
    events: &mpsc::SyncSender<ForwardEvent>,
) -> Result<()> {
    if lock(slot).stopped {
        return Ok(());
    }
    // Dropped last, after the master that listens in it is reaped.
    let dir = ControlDir::create()?;
    let socket = dir.0.join("c");
    // Stderr can carry banners or secrets; nothing reads it.
    let child = master_command(&socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(Error::ForwardSpawn)?;
    // A stop that came while spawning is seen by the first check below.
    lock(slot).child = Some(child);
    let ended = supervise(
        slot,
        remote_port,
        ready_timeout,
        &socket,
        forward_command,
        events,
    );
    let child = lock(slot).child.take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Some(error) = ended {
        let _ = events.try_send(ForwardEvent::Ended(error));
    }
    Ok(())
}

/// Waits for the master, asks it for a listener, then watches it. Returns
/// why the forward ended, or `None` once its owner stopped it.
#[cfg(unix)]
fn supervise(
    slot: &Mutex<Slot>,
    remote_port: NonZeroU16,
    ready_timeout: Duration,
    socket: &Path,
    forward_command: impl Fn(&Path, u16) -> Command,
    events: &mpsc::SyncSender<ForwardEvent>,
) -> Option<Error> {
    // The master opens its control socket only once it has authenticated.
    let deadline = Instant::now() + ready_timeout;
    loop {
        match master(slot) {
            Master::Running => {}
            Master::Stopped => return None,
            Master::Ended(error) => return Some(error),
        }
        if socket.exists() {
            break;
        }
        if Instant::now() >= deadline {
            return Some(Error::ForwardTimeout);
        }
        thread::sleep(STARTING_POLL);
    }
    // The preferred port, then one the system picks. Either can be taken by
    // another process first; the master then refuses it rather than this
    // forward reporting someone else's listener.
    let mut refused = None;
    for attempt in 0..2 {
        let local_port = if attempt == 0 {
            preferred_local_port(remote_port)
        } else {
            match system_port() {
                Ok(port) => port,
                Err(error) => return Some(error),
            }
        };
        let request = crate::ssh::run(
            &mut forward_command(socket, local_port),
            FORWARD_TIMEOUT,
            || lock(slot).stopped,
        );
        match request {
            Ok((status, _)) if status.success() => {
                let _ = events.try_send(ForwardEvent::Listening { local_port });
                refused = None;
                break;
            }
            Ok((status, _)) => refused = Some(Error::ForwardRefused(status)),
            Err(Error::SshCancelled) => return None,
            Err(error) => return Some(error),
        }
        match master(slot) {
            Master::Running => {}
            Master::Stopped => return None,
            Master::Ended(error) => return Some(error),
        }
    }
    if refused.is_some() {
        return refused;
    }
    loop {
        match master(slot) {
            Master::Running => thread::sleep(LISTENING_POLL),
            Master::Stopped => return None,
            Master::Ended(error) => return Some(error),
        }
    }
}

/// A loopback port the system considers free right now.
#[cfg(unix)]
fn system_port() -> Result<u16> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(Error::ForwardLocalPort)
}

/// SSH expands `%` tokens in a `ControlPath`, so a literal one is doubled.
#[cfg(unix)]
fn control_path(socket: &Path) -> String {
    format!(
        "ControlPath={}",
        socket.to_string_lossy().replace('%', "%%")
    )
}

/// The forward's master: noninteractive like the bridge, its own connection
/// rather than any master of the user's (which would adopt the forward and
/// keep it after this child is killed), and a master only for this forward's
/// private socket. `ExitOnForwardFailure` stays off so a `LocalForward` or
/// `RemoteForward` from the user's config that is busy elsewhere cannot end it.
#[cfg(unix)]
fn master_command(target: &str, socket: &Path) -> Command {
    let mut command = Command::new("ssh");
    command
        .args([
            "-N",
            "-T",
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
            "ForwardAgent=no",
            "-o",
            "ExitOnForwardFailure=no",
            "-o",
            "ControlMaster=yes",
            "-o",
            "ControlPersist=no",
            "-o",
        ])
        .arg(control_path(socket))
        .args(["--", target]);
    command
}

/// Asks the master on `socket` to listen on loopback only. It exits 0 only
/// once that master holds the port.
#[cfg(unix)]
fn forward_command(target: &str, socket: &Path, local_port: u16, remote_port: u16) -> Command {
    let mut command = Command::new("ssh");
    command
        .args(["-o", "BatchMode=yes", "-o"])
        .arg(control_path(socket))
        .args(["-O", "forward", "-L"])
        .arg(format!("127.0.0.1:{local_port}:localhost:{remote_port}"))
        .args(["--", target]);
    command
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod tests;
