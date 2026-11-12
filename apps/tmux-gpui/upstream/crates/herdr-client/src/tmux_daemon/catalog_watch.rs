//! Single-generation, read-only catalog notifications. Socket cancellation is
//! immediate; failure is sticky and reconnect is an explicit owner's decision.
use super::{CatalogEventEffect, CatalogEvents, CatalogIdentity, CatalogSource, WorkerError};
use std::{
    net::{Shutdown, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};
#[derive(Debug, thiserror::Error)]
pub enum CatalogWatchError {
    #[error("catalog notification owner unavailable")]
    Owner(#[from] super::Error),
    #[error("catalog notification socket failed")]
    Io(#[from] std::io::Error),
    #[error("catalog notification socket identity failed")]
    Identity(#[from] crate::tmux_ssh::IdentityError),
    #[error("catalog notification protocol failed")]
    Protocol(#[from] super::CatalogEventError),
    #[error("catalog notification websocket failed")]
    Socket(#[source] Box<tungstenite::Error>),
    #[error("catalog notification lane cancelled or closed")]
    Closed,
    #[error("catalog notification deadline expired")]
    Timeout,
}
impl From<tungstenite::Error> for CatalogWatchError {
    fn from(value: tungstenite::Error) -> Self {
        Self::Socket(Box::new(value))
    }
}
#[derive(Default)]
struct Cancellation {
    stopped: Arc<AtomicBool>,
    socket: Mutex<Option<TcpStream>>,
    /// Set once the live lane confirms the daemon pushes fleet changes.
    fleet_push: AtomicBool,
    /// The last sequence the lane has seen, for a later resume.
    sequence: AtomicU64,
    /// The lane passed its barrier.
    live: AtomicBool,
}
impl Cancellation {
    fn check(&self) -> Result<(), CatalogWatchError> {
        if self.stopped.load(Ordering::Acquire) {
            Err(CatalogWatchError::Closed)
        } else {
            Ok(())
        }
    }
    fn install(&self, socket: &TcpStream) -> Result<(), CatalogWatchError> {
        let mut slot = self.socket.lock().map_err(|_| CatalogWatchError::Closed)?;
        self.check()?;
        *slot = Some(socket.try_clone()?);
        Ok(())
    }
    fn cancel(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut slot) = self.socket.lock()
            && let Some(socket) = slot.take()
        {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}
/// A change notice and the lane's end are kept apart: an error never
/// overwrites a change that hasn't been taken yet, so a change seen just
/// before a drop still reaches the caller (`poll` returns it first).
#[derive(Default)]
struct Notices {
    changed: bool,
    failed: Option<CatalogWatchError>,
}
type Mailbox = Arc<Mutex<Notices>>;
pub struct CatalogWatchWorker {
    cancel: Arc<Cancellation>,
    mailbox: Mailbox,
    finished: mpsc::Receiver<()>,
}
impl CatalogWatchWorker {
    pub fn spawn(
        source: CatalogSource,
        expected: CatalogIdentity,
        wake: impl Fn() + Send + 'static,
    ) -> Result<Self, WorkerError> {
        Self::resume(source, expected, None, wake)
    }
    /// Like [`Self::spawn`], but replays only the changes after `after`, a
    /// cursor from an earlier lane whose catalog the caller still holds. The
    /// worker then reports [`Self::live`] instead of an invalidation when
    /// nothing changed.
    pub fn resume(
        source: CatalogSource,
        expected: CatalogIdentity,
        after: Option<u64>,
        wake: impl Fn() + Send + 'static,
    ) -> Result<Self, WorkerError> {
        let cancel = Arc::new(Cancellation::default());
        let stop = cancel.clone();
        let mailbox: Mailbox = Arc::default();
        let output = mailbox.clone();
        let (finished, done) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("tmux-catalog-watch".into())
            .spawn(move || {
                let notify = |result: Result<(), CatalogWatchError>| {
                    let publish = if let Ok(mut slot) = output.lock() {
                        if stop.check().is_ok() {
                            match result {
                                Ok(()) => slot.changed = true,
                                Err(error) => {
                                    slot.failed.get_or_insert(error);
                                }
                            }
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if publish {
                        wake();
                    }
                };
                let woke = || wake();
                if let Err(error) = run(&source, &expected, after, &stop, || notify(Ok(())), woke) {
                    notify(Err(error));
                }
                stop.cancel();
                let _ = finished.send(());
            })
            .map_err(WorkerError::Spawn)?;
        Ok(Self {
            cancel,
            mailbox,
            finished: done,
        })
    }
    /// A pending change first, then the lane's end.
    pub fn poll(&self) -> Result<Option<Result<(), CatalogWatchError>>, WorkerError> {
        let mut notices = self.mailbox.lock().map_err(|_| WorkerError::Closed)?;
        if std::mem::take(&mut notices.changed) {
            return Ok(Some(Ok(())));
        }
        Ok(notices.failed.take().map(Err))
    }
    /// True while this live lane is pushed fleet changes: registered servers,
    /// sessions and agents. Callers may then drop their own periodic reads.
    pub fn fleet_push(&self) -> bool {
        self.cancel.fleet_push.load(Ordering::Acquire) && self.cancel.check().is_ok()
    }
    /// The last sequence the lane has seen. A catalog read started after it
    /// reflects at least every change up to it.
    pub fn sequence(&self) -> u64 {
        self.cancel.sequence.load(Ordering::Acquire)
    }
    /// The lane passed its barrier and is still running.
    pub fn live(&self) -> bool {
        self.cancel.live.load(Ordering::Acquire) && self.cancel.check().is_ok()
    }
    /// Sampled before a catalog read is submitted: a read started now reflects
    /// at least every change up to this sequence. `None` until the lane is
    /// live, when its sequence says nothing about the catalog yet.
    pub fn read_start(&self) -> Option<u64> {
        self.live().then(|| self.sequence())
    }
    /// A worker with no lane, at `sequence` and live, for callers' tests.
    #[doc(hidden)]
    pub fn detached(sequence: u64) -> Self {
        let cancel = Arc::new(Cancellation::default());
        cancel.sequence.store(sequence, Ordering::Release);
        cancel.live.store(true, Ordering::Release);
        let (_, finished) = mpsc::sync_channel(1);
        Self {
            cancel,
            mailbox: Arc::default(),
            finished,
        }
    }
    /// Moves a detached worker's lane on, as a received change would.
    #[doc(hidden)]
    pub fn advance_detached(&self, sequence: u64) {
        self.cancel.sequence.store(sequence, Ordering::Release);
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
        if let Ok(mut slot) = self.mailbox.lock() {
            *slot = Notices::default();
        }
    }
    /// Only a background owner may wait. Discovery has its own 15-second bound.
    pub fn shutdown(&self) -> Result<(), CatalogWatchError> {
        self.cancel();
        match self.finished.recv_timeout(Duration::from_secs(18)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(CatalogWatchError::Timeout),
        }
    }
}
impl Drop for CatalogWatchWorker {
    fn drop(&mut self) {
        self.cancel();
    }
}
fn run(
    source: &CatalogSource,
    expected: &CatalogIdentity,
    after: Option<u64>,
    cancel: &Cancellation,
    changed: impl Fn(),
    woke: impl Fn(),
) -> Result<(), CatalogWatchError> {
    cancel.check()?;
    let owner = source.discover(&cancel.stopped)?;
    let endpoint = owner.catalog_watch_endpoint()?;
    if endpoint.identity.instance_id != expected.instance_id
        || endpoint.identity.environment_id != expected.environment_id
    {
        return Err(super::Error::IdentityChanged.into());
    }
    let socket = TcpStream::connect_timeout(&endpoint.address, Duration::from_millis(2500))?;
    cancel.install(&socket)?;
    socket.set_nodelay(true)?;
    crate::tmux_ssh::verify_socket_identity(&socket, &endpoint.peer, Duration::from_millis(2500))?;
    cancel.check()?;
    owner.check_watch_owner()?;
    // The proof and credential-bearing upgrade share the exact owned socket.
    socket.set_nonblocking(false)?;
    socket.set_read_timeout(Some(Duration::from_millis(2500)))?;
    socket.set_write_timeout(Some(Duration::from_millis(2500)))?;
    let mut request =
        format!("ws://{}/ws/events?mode=semantic", endpoint.address).into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", endpoint.authorization);
    let config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024))
        .max_frame_size(Some(64 * 1024))
        .write_buffer_size(0)
        .max_write_buffer_size(8192);
    let (mut socket, response) =
        tungstenite::client::client_with_config(request, socket, Some(config)).map_err(
            |error| match error {
                tungstenite::HandshakeError::Failure(error) => CatalogWatchError::from(error),
                tungstenite::HandshakeError::Interrupted(_) => CatalogWatchError::Timeout,
            },
        )?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(1)))?;
    let mut lane = match after {
        Some(after) => CatalogEvents::resume(endpoint.identity, after),
        None => CatalogEvents::new(endpoint.identity),
    };
    // A daemon that advertises its heartbeat pings by itself: its own limit
    // applies. Any other daemon is judged by the pongs to this lane's pings.
    let silence = crate::tmux_heartbeat::Heartbeat::advertised(&response)
        .map_or(UNANSWERED, |heartbeat| heartbeat.silence());
    let ready_deadline = Instant::now() + Duration::from_secs(5);
    let mut received = Instant::now();
    let mut ping = received;
    let mut refresh = received;
    loop {
        cancel.check()?;
        let now = Instant::now();
        if (!lane.ready() && now >= ready_deadline) || now.duration_since(received) >= silence {
            return Err(CatalogWatchError::Timeout);
        }
        // Fleet push covers separately registered tmux owners. Only a daemon
        // without it keeps Home's bounded fallback; this never reconnects a
        // stopped lane.
        if lane.ready()
            && lane.needs_fallback()
            && now.duration_since(refresh) >= Duration::from_secs(5)
        {
            changed();
            refresh = now;
        }
        if now.duration_since(ping) >= Duration::from_secs(15) {
            socket.send(Message::Ping(Vec::new().into()))?;
            ping = now;
        }
        let message = match socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        received = Instant::now();
        cancel.check()?;
        match message {
            Message::Text(text) => match lane.receive(text.as_bytes()).inspect(|_| {
                cancel.sequence.store(lane.sequence(), Ordering::Release);
                cancel.live.store(lane.ready(), Ordering::Release);
            })? {
                CatalogEventEffect::Subscribe { after_sequence } => socket.send(Message::Text(
                    CatalogEvents::subscription(after_sequence)?.into(),
                ))?,
                CatalogEventEffect::Invalidate => {
                    cancel
                        .fleet_push
                        .store(lane.ready() && !lane.needs_fallback(), Ordering::Release);
                    changed();
                    refresh = Instant::now();
                }
                CatalogEventEffect::Resumed => {
                    cancel
                        .fleet_push
                        .store(!lane.needs_fallback(), Ordering::Release);
                    woke();
                }
                CatalogEventEffect::Unchanged => {}
            },
            Message::Ping(_) => socket.flush()?,
            Message::Pong(_) => {}
            Message::Close(_) => return Err(CatalogWatchError::Closed),
            _ => return Err(super::CatalogEventError::Frame.into()),
        }
    }
}
/// Three of this lane's own pings (one every 15 s) without any frame back.
const UNANSWERED: Duration = Duration::from_secs(45);
#[cfg(all(test, unix))]
#[path = "catalog_watch_tests.rs"]
mod tests;
