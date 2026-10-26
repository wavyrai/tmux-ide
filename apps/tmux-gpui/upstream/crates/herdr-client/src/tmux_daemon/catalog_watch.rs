//! Single-generation, read-only catalog notifications. Socket cancellation is
//! immediate; failure is sticky and reconnect is an explicit owner's decision.
use super::{CatalogEventEffect, CatalogEvents, CatalogIdentity, CatalogSource, WorkerError};
use std::{
    net::{Shutdown, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
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
type Mailbox = Arc<Mutex<Option<Result<(), CatalogWatchError>>>>;
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
        let cancel = Arc::new(Cancellation::default());
        let stop = cancel.clone();
        let mailbox: Mailbox = Arc::new(Mutex::new(None));
        let output = mailbox.clone();
        let (finished, done) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("tmux-catalog-watch".into())
            .spawn(move || {
                let notify = |result| {
                    let publish = if let Ok(mut slot) = output.lock() {
                        if stop.check().is_ok() {
                            if !matches!(*slot, Some(Err(_))) {
                                *slot = Some(result);
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
                if let Err(error) = run(&source, &expected, &stop, || notify(Ok(()))) {
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
    pub fn poll(&self) -> Result<Option<Result<(), CatalogWatchError>>, WorkerError> {
        Ok(self.mailbox.lock().map_err(|_| WorkerError::Closed)?.take())
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
        if let Ok(mut slot) = self.mailbox.lock() {
            *slot = None;
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
    cancel: &Cancellation,
    changed: impl Fn(),
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
    let (mut socket, _) = tungstenite::client::client_with_config(request, socket, Some(config))
        .map_err(|error| match error {
            tungstenite::HandshakeError::Failure(error) => CatalogWatchError::from(error),
            tungstenite::HandshakeError::Interrupted(_) => CatalogWatchError::Timeout,
        })?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(1)))?;
    let mut lane = CatalogEvents::new(endpoint.identity);
    let ready_deadline = Instant::now() + Duration::from_secs(5);
    let mut received = Instant::now();
    let mut ping = received;
    let mut refresh = received;
    loop {
        cancel.check()?;
        let now = Instant::now();
        if (!lane.ready() && now >= ready_deadline)
            || now.duration_since(received) >= Duration::from_secs(45)
        {
            return Err(CatalogWatchError::Timeout);
        }
        // Root push cannot observe every separately registered tmux owner.
        // Match Home's bounded fallback; this never reconnects a stopped lane.
        if lane.ready() && now.duration_since(refresh) >= Duration::from_secs(5) {
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
            Message::Text(text) => match lane.receive(text.as_bytes())? {
                CatalogEventEffect::Subscribe { after_sequence } => socket.send(Message::Text(
                    CatalogEvents::subscription(after_sequence)?.into(),
                ))?,
                CatalogEventEffect::Invalidate => {
                    changed();
                    refresh = Instant::now();
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
#[cfg(all(test, unix))]
#[path = "catalog_watch_tests.rs"]
mod tests;
