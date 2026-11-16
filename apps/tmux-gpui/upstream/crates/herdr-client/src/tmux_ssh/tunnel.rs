//! The GUI owns only the SSH forward process, never the remote daemon. Retirement
//! is signalled immediately; bounded graceful shutdown and reaping happen off-UI.
use super::{
    RemoteDescriptor, SshTarget,
    discovery::{Diagnostics, nonblocking},
    tunnel_command,
};
use std::{
    io::{self, Read},
    net::TcpListener,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        mpsc::{self, RecvTimeoutError, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, thiserror::Error)]
pub enum TunnelError {
    #[error("SSH tunnel shutdown did not complete before its deadline")]
    ShutdownTimeout,
    #[error("SSH tunnel I/O failed")]
    Io(#[source] Arc<io::Error>),
    #[error("SSH host key verification failed")]
    HostKey,
    #[error("SSH authentication failed")]
    Authentication,
    #[error("SSH tunnel exited")]
    Exited,
    #[error("SSH tunnel was retired")]
    Retired,
    #[error("SSH tunnel worker failed")]
    Worker,
}
impl From<io::Error> for TunnelError {
    fn from(error: io::Error) -> Self {
        Self::Io(Arc::new(error))
    }
}
/// The guard's lifeline: the app holds the only writer of its stdin.
struct OwnedChild(Child, Option<ChildStdin>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // The guard ends the forward once the lifeline closes, reaps it and
        // exits. While the shell lives the forward's pid stays its child, so
        // the watcher's late KILL cannot reach a reused pid (review of
        // 18c558c5). Only a guard that has not ended by then is killed.
        drop(self.1.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !matches!(self.0.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
/// What the forward runs under (#723 follow-up, 16 Nov: three `ssh -N -L`
/// forwards outlived the app by two weeks). A shell starts the forward and a
/// watcher that blocks on the shell's stdin, a pipe whose only writer is the
/// app. When the app quits, crashes or is killed, the kernel closes that
/// writer, the watcher reads end of file and ends the forward (TERM, then KILL
/// a second later). TERM to the shell itself is passed on to the forward. No
/// process is ever found by name: only the forward this shell started is
/// signalled. `$0` names the shell in `ps` as the app's tunnel. The shell's
/// own messages ("Terminated", "Killed: 9") go nowhere: only the forward's
/// stderr reaches the tunnel, which classifies it.
const GUARD: &str = r#"exec 3<&0 4>&2 2>/dev/null
"$@" </dev/null 2>&4 3<&- 4>&- &
tunnel=$!
{ read -r _ <&3; kill -TERM "$tunnel"; sleep 1; kill -KILL "$tunnel"; } 4>&- &
guard=$!
exec 3<&- 4>&-
trap 'kill -TERM "$tunnel" 2>/dev/null' TERM HUP INT
wait "$tunnel"
status=$?
while kill -0 "$tunnel" 2>/dev/null; do
  wait "$tunnel"
  status=$?
done
kill "$guard" 2>/dev/null
exit "$status""#;
/// The marker `ps` shows for a forward's guard shell.
pub(super) const GUARD_NAME: &str = "tmux-ide-ssh-tunnel";
/// `command` under the guard: it ends when the app's end of stdin closes.
pub(super) fn guarded(command: &Command) -> Command {
    let mut guarded = Command::new("/bin/sh");
    guarded
        .args(["-c", GUARD, GUARD_NAME])
        .arg(command.get_program())
        .args(command.get_args());
    for (key, value) in command.get_envs() {
        match value {
            Some(value) => guarded.env(key, value),
            None => guarded.env_remove(key),
        };
    }
    if let Some(dir) = command.get_current_dir() {
        guarded.current_dir(dir);
    }
    guarded
}
/// This guard may be dropped on the UI thread. It is not a connection identity
/// proof: all forwarded HTTP/WebSocket connections still require their own proof.
pub struct Tunnel {
    port: u16,
    state: Arc<Mutex<Result<(), TunnelError>>>,
    stop: SyncSender<()>,
    worker: JoinHandle<()>,
    closed: Arc<(Mutex<bool>, Condvar)>,
}
impl Tunnel {
    /// Call from a worker. A released port reservation is only a routing hint;
    /// successful bind or TCP readiness never authorizes credential forwarding.
    pub fn spawn(target: &SshTarget, descriptor: &RemoteDescriptor) -> Result<Self, TunnelError> {
        let reservation = TcpListener::bind("127.0.0.1:0")?;
        let port = reservation.local_addr()?.port();
        let command = tunnel_command(target, port, descriptor).map_err(|_| TunnelError::Worker)?;
        drop(reservation);
        Self::spawn_command(command, port)
    }
    pub fn port(&self) -> u16 {
        self.port
    }
    /// Liveness is advisory; authenticate the actual connection, not this flag.
    pub fn check(&self) -> Result<(), TunnelError> {
        self.state.lock().map_err(|_| TunnelError::Worker)?.clone()
    }
    /// Explicitly retire before dropping other route resources. No waiting here.
    pub fn retire(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = Err(TunnelError::Retired);
        }
        let _ = self.stop.try_send(());
    }
    /// For worker teardown/tests, never an active UI callback.
    pub fn shutdown(self) -> Result<(), TunnelError> {
        self.retire();
        self.worker.join().map_err(|_| TunnelError::Worker)
    }
    /// Call only after the UI loop or on a background worker. Retirement is not
    /// completion: this acknowledgement follows killing and reaping the child.
    pub(super) fn wait_closed(&self, timeout: Duration) -> Result<(), TunnelError> {
        let (lock, wake) = &*self.closed;
        let closed = lock.lock().map_err(|_| TunnelError::Worker)?;
        let (closed, _) = wake
            .wait_timeout_while(closed, timeout, |closed| !*closed)
            .map_err(|_| TunnelError::Worker)?;
        if !*closed {
            return Err(TunnelError::ShutdownTimeout);
        }
        Ok(())
    }
    pub(super) fn spawn_command(command: Command, port: u16) -> Result<Self, TunnelError> {
        let mut spawned = guarded(&command)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        let lifeline = spawned.stdin.take();
        let mut child = OwnedChild(spawned, lifeline);
        let mut stderr = child
            .0
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("missing SSH stderr"))?;
        nonblocking(&stderr)?;
        let state = Arc::new(Mutex::new(Ok(())));
        let observed = state.clone();
        let closed = Arc::new((Mutex::new(false), Condvar::new()));
        let completion = closed.clone();
        let (stop, stopped) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("tmux-ssh-tunnel".into())
            .spawn(move || {
                let mut diagnostics = Diagnostics::default();
                let result = loop {
                    let mut buffer = [0; 4096];
                    let mut read_error = None;
                    for _ in 0..8 {
                        match stderr.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(count) => diagnostics.observe(&buffer[..count]),
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                            Err(error) => {
                                read_error = Some(error);
                                break;
                            }
                        }
                    }
                    if let Some(error) = read_error {
                        break TunnelError::from(error);
                    }
                    match child.0.try_wait() {
                        Ok(Some(_)) => {
                            break match diagnostics.failure() {
                                super::DiscoveryError::HostKey => TunnelError::HostKey,
                                super::DiscoveryError::Authentication => {
                                    TunnelError::Authentication
                                }
                                _ => TunnelError::Exited,
                            };
                        }
                        Err(error) => break TunnelError::from(error),
                        Ok(None) => {}
                    }
                    match stopped.recv_timeout(Duration::from_millis(25)) {
                        Ok(()) | Err(RecvTimeoutError::Disconnected) => break TunnelError::Retired,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                };
                if let Ok(mut state) = observed.lock() {
                    // Explicit retirement must never become live again or be replaced
                    // by a late process-exit notification for this generation.
                    if state.is_ok() {
                        *state = Err(result);
                    }
                }
                terminate(&mut child.0);
                drop(child);
                let (lock, wake) = &*completion;
                if let Ok(mut closed) = lock.lock() {
                    *closed = true;
                    wake.notify_all();
                }
            })?;
        Ok(Self {
            port,
            state,
            stop,
            worker,
            closed,
        })
    }
}
fn terminate(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    if let Ok(pid) = i32::try_from(child.id())
        && let Some(pid) = rustix::process::Pid::from_raw(pid)
    {
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
    }
    let deadline = Instant::now() + Duration::from_millis(250);
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    // OwnedChild's drop escalates and reaps. No process-name/group targeting.
}
#[cfg(test)]
#[path = "tunnel_tests.rs"]
mod tests;
