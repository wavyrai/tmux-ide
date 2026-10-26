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
    process::{Child, Command, Stdio},
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
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
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
    pub(super) fn spawn_command(mut command: Command, port: u16) -> Result<Self, TunnelError> {
        let mut child = OwnedChild(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()?,
        );
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
