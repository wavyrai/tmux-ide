//! One machine's bridge lane (protocol v1): copies made by programs in that
//! machine's panes. Only a daemon of 2.9.28 or later is asked, and only one
//! whose capabilities answer offers the bridge gets a connection; any other
//! daemon gets none and the app behaves as before.
//! Failure is sticky; reconnecting is the owner's decision, as for the
//! catalog lane. The lane only receives reports: it sends the hello and
//! nothing else, and never reads the pasteboard.
use super::{
    CatalogSource,
    remote_bridge_wire::{self as wire, BridgeEvent, Received, WireError},
};
use std::{
    collections::VecDeque,
    net::{Shutdown, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};

#[derive(Debug, thiserror::Error)]
pub enum RemoteBridgeError {
    #[error("bridge owner unavailable")]
    Owner(#[from] super::Error),
    #[error("bridge socket failed")]
    Io(#[from] std::io::Error),
    #[error("bridge socket identity failed")]
    Identity(#[from] crate::tmux_ssh::IdentityError),
    #[error("bridge websocket failed")]
    Socket(#[source] Box<tungstenite::Error>),
    #[error("bridge protocol failed")]
    Protocol(#[from] WireError),
    #[error("bridge lane cancelled or closed")]
    Closed,
    #[error("bridge deadline expired")]
    Timeout,
}
impl From<tungstenite::Error> for RemoteBridgeError {
    fn from(value: tungstenite::Error) -> Self {
        Self::Socket(Box::new(value))
    }
}

/// How a lane ended.
#[derive(Debug)]
pub enum BridgeEnd {
    /// The daemon does not offer the bridge (an older daemon): nothing to do.
    Unsupported,
    Failed(RemoteBridgeError),
}

/// Copies wait here for the UI. A UI that stalls keeps the newest ones.
const MAX_PENDING: usize = 16;

#[derive(Default)]
struct Mailbox {
    events: VecDeque<BridgeEvent>,
    end: Option<BridgeEnd>,
}

#[derive(Default)]
struct Cancellation {
    stopped: Arc<AtomicBool>,
    socket: Mutex<Option<TcpStream>>,
    live: AtomicBool,
}
impl Cancellation {
    fn check(&self) -> Result<(), RemoteBridgeError> {
        if self.stopped.load(Ordering::Acquire) {
            Err(RemoteBridgeError::Closed)
        } else {
            Ok(())
        }
    }
    fn install(&self, socket: &TcpStream) -> Result<(), RemoteBridgeError> {
        let mut slot = self.socket.lock().map_err(|_| RemoteBridgeError::Closed)?;
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

pub struct RemoteBridgeWorker {
    cancel: Arc<Cancellation>,
    mailbox: Arc<Mutex<Mailbox>>,
}

impl RemoteBridgeWorker {
    pub fn spawn(
        source: CatalogSource,
        wake: impl Fn() + Send + 'static,
    ) -> Result<Self, super::WorkerError> {
        let cancel = Arc::new(Cancellation::default());
        let mailbox = Arc::new(Mutex::new(Mailbox::default()));
        let (stop, output) = (cancel.clone(), mailbox.clone());
        thread::Builder::new()
            .name("tmux-remote-bridge".into())
            .spawn(move || {
                let deliver = |event: BridgeEvent| {
                    if stop.check().is_err() {
                        return;
                    }
                    if let Ok(mut slot) = output.lock() {
                        if slot.events.len() >= MAX_PENDING {
                            slot.events.pop_front();
                        }
                        slot.events.push_back(event);
                    }
                    wake();
                };
                let end = match run(&source, &stop, deliver) {
                    Ok(Lane::Unsupported) => BridgeEnd::Unsupported,
                    Err(error) => BridgeEnd::Failed(error),
                };
                if stop.check().is_ok()
                    && let Ok(mut slot) = output.lock()
                {
                    slot.end = Some(end);
                    drop(slot);
                    wake();
                }
                stop.cancel();
            })
            .map_err(super::WorkerError::Spawn)?;
        Ok(Self { cancel, mailbox })
    }
    /// The copies received since the last call, oldest first.
    pub fn take_events(&self) -> Vec<BridgeEvent> {
        self.mailbox
            .lock()
            .map(|mut slot| slot.events.drain(..).collect())
            .unwrap_or_default()
    }
    /// How the lane ended, once.
    pub fn take_end(&self) -> Option<BridgeEnd> {
        self.mailbox
            .lock()
            .ok()
            .and_then(|mut slot| slot.end.take())
    }
    /// The lane passed its ready frame and is still running.
    pub fn live(&self) -> bool {
        self.cancel.live.load(Ordering::Acquire) && self.cancel.check().is_ok()
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
}
impl Drop for RemoteBridgeWorker {
    fn drop(&mut self) {
        self.cancel();
    }
}

enum Lane {
    Unsupported,
}

fn run(
    source: &CatalogSource,
    cancel: &Cancellation,
    deliver: impl Fn(BridgeEvent),
) -> Result<Lane, RemoteBridgeError> {
    cancel.check()?;
    let owner = source.discover(&cancel.stopped)?;
    if !super::capability::knows_remote_bridge(Some(owner.product_version())) {
        return Ok(Lane::Unsupported);
    }
    let offer = owner.post_resource(wire::CAPABILITY_PATH, b"{}")?;
    cancel.check()?;
    if !wire::offers_clipboard(&offer) {
        return Ok(Lane::Unsupported);
    }
    let endpoint = owner.catalog_watch_endpoint()?;
    let socket = TcpStream::connect_timeout(&endpoint.address, Duration::from_millis(2500))?;
    cancel.install(&socket)?;
    socket.set_nodelay(true)?;
    crate::tmux_ssh::verify_socket_identity(&socket, &endpoint.peer, Duration::from_millis(2500))?;
    cancel.check()?;
    owner.check_watch_owner()?;
    // The proof and the credential-bearing upgrade share the exact owned socket.
    socket.set_nonblocking(false)?;
    socket.set_read_timeout(Some(Duration::from_millis(2500)))?;
    socket.set_write_timeout(Some(Duration::from_millis(2500)))?;
    let mut request = format!("ws://{}{}", endpoint.address, wire::PATH).into_client_request()?;
    let headers = request.headers_mut();
    headers.insert("Authorization", endpoint.authorization);
    headers.insert(
        "Sec-WebSocket-Protocol",
        tungstenite::http::HeaderValue::from_static(wire::SUBPROTOCOL),
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(wire::MAX_MESSAGE_BYTES))
        .max_frame_size(Some(wire::MAX_MESSAGE_BYTES))
        .write_buffer_size(0)
        .max_write_buffer_size(8192);
    let (mut socket, response) =
        tungstenite::client::client_with_config(request, socket, Some(config)).map_err(
            |error| match error {
                tungstenite::HandshakeError::Failure(error) => RemoteBridgeError::from(error),
                tungstenite::HandshakeError::Interrupted(_) => RemoteBridgeError::Timeout,
            },
        )?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(1)))?;
    socket.send(Message::Text(wire::HELLO.into()))?;
    let silence = crate::tmux_heartbeat::Heartbeat::advertised(&response)
        .map_or(UNANSWERED, |heartbeat| heartbeat.silence());
    let ready_deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = false;
    let mut received = Instant::now();
    let mut ping = received;
    loop {
        cancel.check()?;
        let now = Instant::now();
        if (!ready && now >= ready_deadline) || now.duration_since(received) >= silence {
            return Err(RemoteBridgeError::Timeout);
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
            Message::Text(text) => match (ready, wire::receive(text.as_str())?) {
                (false, Received::Ready) => {
                    ready = true;
                    cancel.live.store(true, Ordering::Release);
                }
                // A second ready, or a report before the first, breaks the protocol.
                (true, Received::Ready) | (false, Received::Event(_)) => {
                    return Err(WireError::Malformed.into());
                }
                (true, Received::Event(event)) => deliver(event),
                (_, Received::Ignored) => {}
            },
            Message::Ping(_) => socket.flush()?,
            Message::Pong(_) => {}
            Message::Close(_) => return Err(RemoteBridgeError::Closed),
            _ => return Err(WireError::Malformed.into()),
        }
    }
}
/// Three of this lane's own pings (one every 15 s) without any frame back.
const UNANSWERED: Duration = Duration::from_secs(45);

#[cfg(all(test, unix))]
#[path = "remote_bridge_tests.rs"]
mod tests;
