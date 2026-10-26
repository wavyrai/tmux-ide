use std::{
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use crossbeam_channel::{Receiver, SendTimeoutError, Sender, TrySendError, bounded};
use tungstenite::{
    Message, client::IntoClientRequest, handshake::HandshakeError, protocol::WebSocketConfig,
};

use super::{ConnectOptions, Error, Event, MAX_CLIENT_BYTES, MAX_SERVER_BYTES, SUBPROTOCOL, wire};

const POLL: Duration = Duration::from_millis(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// A pre-serialized existing protocol command, never a request to invent authority.
pub struct Command(String);

impl Command {
    pub fn from_json(json: String) -> Result<Self, Error> {
        if json.len() > MAX_CLIENT_BYTES {
            return Err(Error::FrameBound);
        }
        let value: serde_json::Value = serde_json::from_str(&json).map_err(Error::Json)?;
        let kind = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or(Error::Frame)?;
        if !matches!(
            kind,
            "presence"
                | "activity"
                | "authority-request"
                | "authority-release"
                | "input"
                | "viewport"
                | "semantic-intent"
                | "terminal-delivery-ack"
                | "terminal-projection-receipt"
                | "terminal-projection-materialize"
                | "terminal-delivery-nack"
                | "terminal-delivery-visibility"
                | "terminal-cell-pixels"
                | "terminal-graphics-request"
                | "terminal-graphics-local-release"
                | "terminal-surface-watch"
                | "terminal-surface-receiver"
                | "terminal-surface-retired"
                | "terminal-surface-fallback"
        ) {
            return Err(Error::Frame);
        }
        Ok(Self(json))
    }
}

struct Cancellation {
    cancelled: AtomicBool,
    socket: Mutex<Option<TcpStream>>,
}

impl Cancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(socket) = self.socket.lock()
            && let Some(socket) = socket.as_ref()
        {
            // shutdown interrupts the worker's exact socket; no join or queued writes.
            let _ = socket.shutdown(Shutdown::Both);
        }
    }

    fn check(&self) -> Result<(), Error> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Owns one physical connection. Dropping it cancels without joining or replaying.
pub struct PaneStream {
    commands: Sender<Command>,
    events: Receiver<Event>,
    completion: Receiver<Error>,
    cancellation: Arc<Cancellation>,
}

impl PaneStream {
    /// Validates locally, then performs all connection and wire work off the caller thread.
    pub fn spawn(mut options: ConnectOptions) -> Result<Self, Error> {
        let peer = options.remote_peer.take();
        Self::spawn_inner(options, peer)
    }
    /// Prove the SSH-discovered peer on the physical socket before upgrading or
    /// redeeming. The expected identity contains no reusable daemon credential.
    pub fn spawn_remote(
        mut options: ConnectOptions,
        peer: crate::tmux_ssh::PeerIdentity,
    ) -> Result<Self, Error> {
        options.remote_peer = Some(peer);
        Self::spawn(options)
    }
    fn spawn_inner(
        options: ConnectOptions,
        peer: Option<crate::tmux_ssh::PeerIdentity>,
    ) -> Result<Self, Error> {
        options.descriptor.validate()?;
        validate_headers(&options)?;
        let (commands_tx, commands) = bounded(32);
        let (events_tx, events) = bounded(8);
        let (completion_tx, completion) = bounded(1);
        let cancellation = Arc::new(Cancellation {
            cancelled: AtomicBool::new(false),
            socket: Mutex::new(None),
        });
        let worker_cancellation = Arc::clone(&cancellation);
        thread::Builder::new()
            .name("tmux-pane-stream".into())
            .spawn(move || {
                // Keep events connected until the terminal result is published. Otherwise
                // a consumer can observe EOF first and lose the actual failure reason.
                let completion_guard = events_tx.clone();
                let result = run(options, peer, commands, events_tx, &worker_cancellation);
                let error = if worker_cancellation.check().is_err() {
                    Error::Cancelled
                } else {
                    result.err().unwrap_or(Error::Disconnected)
                };
                worker_cancellation.cancel();
                let _ = completion_tx.try_send(error);
                drop(completion_guard);
            })?;
        Ok(Self {
            commands: commands_tx,
            events,
            completion,
            cancellation,
        })
    }

    pub fn try_send(&self, command: Command) -> Result<(), Error> {
        self.cancellation.check()?;
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                TrySendError::Full(_) => Error::CommandBacklog,
                TrySendError::Disconnected(_) => Error::Disconnected,
            })
    }

    pub fn events(&self) -> &Receiver<Event> {
        &self.events
    }

    /// Exactly one terminal result, even if the event queue filled. Never clone these receivers.
    pub fn completion(&self) -> &Receiver<Error> {
        &self.completion
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }
}

impl Drop for PaneStream {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn validate_headers(options: &ConnectOptions) -> Result<(), Error> {
    if options.origin.is_empty()
        || options.origin.len() > 2048
        || options.host_client_id.is_empty()
        || options.host_client_id.len() > 4096
    {
        return Err(Error::Headers);
    }
    for value in [
        &options.origin,
        &options.host_client_id,
        &options.descriptor.request_id,
    ] {
        tungstenite::http::HeaderValue::from_str(value).map_err(|_| Error::Headers)?;
    }
    Ok(())
}

/// Observe read-ahead without retaining or copying terminal payloads.
struct Stream {
    socket: TcpStream,
    boundary: super::boundary::Boundary,
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.socket.read(buf)?;
        self.boundary.observe(&buf[..read]);
        if self.boundary.binary_oversized() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "binary graphics bound exceeded",
            ));
        }
        Ok(read)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.socket.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.socket.flush()
    }
}

fn run(
    options: ConnectOptions,
    peer: Option<crate::tmux_ssh::PeerIdentity>,
    commands: Receiver<Command>,
    events: Sender<Event>,
    cancel: &Cancellation,
) -> Result<(), Error> {
    cancel.check()?;
    let url = options.descriptor.validate()?;
    // Never resolve a hostname from an issued capability. localhost is the literal loopback.
    let ip = if url.host_str() == Some("[::1]") {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let port = url.port().ok_or(Error::Descriptor)?;
    let socket = TcpStream::connect_timeout(&SocketAddr::new(ip, port), CONNECT_TIMEOUT)?;
    socket.set_nodelay(true)?;
    socket.set_nonblocking(true)?;
    {
        let mut owned = cancel.socket.lock().map_err(|_| Error::Cancelled)?;
        cancel.check()?;
        *owned = Some(socket.try_clone()?);
    }
    if let Some(peer) = peer {
        crate::tmux_ssh::verify_socket_identity(&socket, &peer, CONNECT_TIMEOUT)
            .map_err(Error::RemoteIdentity)?;
        cancel.check()?;
    }
    let mut request = options
        .descriptor
        .web_socket_url
        .as_str()
        .into_client_request()?;
    for (key, value) in [
        ("Origin", options.origin.as_str()),
        ("X-Tmux-Ide-Host-Client-Id", options.host_client_id.as_str()),
        (
            "X-Tmux-Ide-Request-Id",
            options.descriptor.request_id.as_str(),
        ),
        ("Sec-WebSocket-Protocol", SUBPROTOCOL),
    ] {
        request.headers_mut().insert(
            tungstenite::http::HeaderName::from_bytes(key.as_bytes())
                .map_err(|_| Error::Headers)?,
            tungstenite::http::HeaderValue::from_str(value).map_err(|_| Error::Headers)?,
        );
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_SERVER_BYTES))
        .max_frame_size(Some(MAX_SERVER_BYTES))
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_CLIENT_BYTES * 2);
    let stream = Stream {
        socket,
        boundary: super::boundary::Boundary::default(),
    };
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut handshake = tungstenite::client::client_with_config(request, stream, Some(config));
    let (mut socket, response) = loop {
        cancel.check()?;
        if Instant::now() >= deadline {
            return Err(Error::ReadyTimeout);
        }
        match handshake {
            Ok(connection) => break connection,
            Err(HandshakeError::Failure(error)) => return Err(error.into()),
            Err(HandshakeError::Interrupted(mid)) => {
                thread::sleep(POLL);
                handshake = mid.handshake();
            }
        }
    };
    if response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok())
        != Some(SUBPROTOCOL)
    {
        return Err(Error::Identity);
    }
    socket.get_mut().socket.set_nonblocking(false)?;
    socket.get_mut().socket.set_read_timeout(Some(POLL))?;
    socket
        .get_mut()
        .socket
        .set_write_timeout(Some(Duration::from_millis(250)))?;
    cancel.check()?;
    let redeem = wire::redeem(&options)?;
    if redeem.len() > MAX_CLIENT_BYTES {
        return Err(Error::FrameBound);
    }
    socket.send(Message::Text(redeem.into()))?;
    let mut verified = false;
    loop {
        cancel.check()?;
        if !verified && Instant::now() >= deadline {
            return Err(Error::ReadyTimeout);
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                let event = wire::parse(&text, &options, verified)?;
                verified = true;
                deliver(&events, event, cancel)?;
            }
            Ok(Message::Binary(bytes)) => {
                if !verified || bytes.len() > 8 + 4096 + 512 * 1024 {
                    return Err(Error::FrameBound);
                }
                deliver(&events, wire::parse_binary(&bytes, &options)?, cancel)?;
            }
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            Ok(Message::Close(_)) => return Err(Error::Disconnected),
            Ok(_) => return Err(Error::Frame),
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return Err(Error::Disconnected);
            }
            Err(error) => return Err(error.into()),
        }
        // A fragmented message is retained by tungstenite. A timeout cannot release
        // application commands against the state preceding that unfinished message.
        if !verified || socket.get_ref().boundary.is_partial() {
            continue;
        }
        for _ in 0..16 {
            cancel.check()?;
            let Ok(command) = commands.try_recv() else {
                break;
            };
            socket.send(Message::Text(command.0.into()))?;
        }
    }
}

// A burst cannot drop terminal frames. Bounded retention and a finite stall deadline
// propagate backpressure to TCP while the authoritative receiver catches up.
fn deliver(events: &Sender<Event>, mut event: Event, cancel: &Cancellation) -> Result<(), Error> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cancel.check()?;
        if Instant::now() >= deadline {
            return Err(Error::EventBacklog);
        }
        match events.send_timeout(event, POLL) {
            Ok(()) => return Ok(()),
            Err(SendTimeoutError::Timeout(pending)) => event = pending,
            Err(SendTimeoutError::Disconnected(_)) => return Err(Error::Cancelled),
        }
    }
}
