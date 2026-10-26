//! Background-only local native producer transport. No credential-bearing URL or
//! caller-supplied endpoint is accepted; discovery and socket proof own identity.
use super::{LocalDaemon, owner::Owner};
use crate::tmux_graphics::surface_provider::{self as wire, Event};
use std::{
    net::{Shutdown, TcpStream},
    sync::Arc,
    time::{Duration, Instant},
};
use tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum SurfaceProviderError {
    #[error("native producer owner unavailable")]
    Owner(#[from] super::Error),
    #[error("native producer socket failed")]
    Io(#[from] std::io::Error),
    #[error("native producer socket identity failed")]
    Identity(#[from] crate::tmux_ssh::IdentityError),
    #[error("native producer control failed")]
    Control(#[from] wire::Error),
    #[error("native producer websocket failed")]
    Socket(#[source] Box<tungstenite::Error>),
    #[error("native producer registration timed out")]
    Timeout,
    #[error("native producer protocol mismatch")]
    Protocol,
    #[error("native producer offer window is unavailable or full")]
    Capacity,
    #[error("native producer connection closed")]
    Closed,
}
impl From<tungstenite::Error> for SurfaceProviderError {
    fn from(error: tungstenite::Error) -> Self {
        Self::Socket(Box::new(error))
    }
}
/// Socket ownership is private. Use only on a dedicated producer worker; dropping
/// it closes the original connection and never authorizes native buffer reuse.
pub struct SurfaceProvider {
    socket: tungstenite::WebSocket<TcpStream>,
    owner: Arc<LocalDaemon>,
    generation: Uuid,
    closed: bool,
    ledger: super::surface_provider_ledger::Ledger,
}
impl LocalDaemon {
    pub fn connect_surface_provider(
        self: &Arc<Self>,
        audit_token: [u32; 8],
    ) -> Result<SurfaceProvider, SurfaceProviderError> {
        let owner = Owner::Local(Arc::clone(self));
        let endpoint = owner.catalog_watch_endpoint()?;
        let generation = Uuid::parse_str(&endpoint.identity.instance_id)
            .map_err(|_| SurfaceProviderError::Protocol)?;
        let registration = wire::register(generation, audit_token)?;
        let socket = TcpStream::connect_timeout(&endpoint.address, Duration::from_millis(2500))?;
        socket.set_nodelay(true)?;
        crate::tmux_ssh::verify_socket_identity(
            &socket,
            &endpoint.peer,
            Duration::from_millis(2500),
        )?;
        owner.check_watch_owner()?;
        socket.set_nonblocking(false)?;
        socket.set_read_timeout(Some(Duration::from_millis(2500)))?;
        socket.set_write_timeout(Some(Duration::from_millis(2500)))?;
        let mut request =
            format!("ws://{}{}", endpoint.address, wire::PATH).into_client_request()?;
        request
            .headers_mut()
            .insert("Authorization", endpoint.authorization);
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            tungstenite::http::HeaderValue::from_static(wire::PROTOCOL),
        );
        let config = WebSocketConfig::default()
            .max_message_size(Some(16384))
            .max_frame_size(Some(16384))
            .write_buffer_size(0)
            .max_write_buffer_size(65536);
        let (mut socket, response) = tungstenite::client::client_with_config(
            request,
            socket,
            Some(config),
        )
        .map_err(|error| match error {
            tungstenite::HandshakeError::Failure(error) => SurfaceProviderError::from(error),
            tungstenite::HandshakeError::Interrupted(_) => SurfaceProviderError::Timeout,
        })?;
        if response
            .headers()
            .get("Sec-WebSocket-Protocol")
            .and_then(|v| v.to_str().ok())
            != Some(wire::PROTOCOL)
        {
            return Err(SurfaceProviderError::Protocol);
        }
        owner.check_watch_owner()?;
        socket.send(Message::Text(registration.into()))?;
        let mut provider = SurfaceProvider {
            socket,
            owner: Arc::clone(self),
            generation,
            closed: false,
            ledger: Default::default(),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline {
                return Err(SurfaceProviderError::Timeout);
            }
            match provider.receive()? {
                Some(Event::Registered { .. }) => break,
                Some(_) => return Err(SurfaceProviderError::Protocol),
                None => {}
            }
        }
        provider.socket.get_mut().set_nonblocking(true)?;
        Ok(provider)
    }
}
impl SurfaceProvider {
    pub fn kitty_required(&self, pane: &str) -> bool {
        self.closed || self.ledger.kitty_required(pane)
    }
    pub fn watch_demand(&mut self, panes: &[String]) -> Result<(), SurfaceProviderError> {
        if self.closed {
            return Err(SurfaceProviderError::Closed);
        }
        let encoded = wire::watch_demand(panes)?;
        let result = (|| {
            self.owner.check_record()?;
            if !self.ledger.watch(panes.to_vec())? {
                return Ok(());
            }
            match self.socket.send(Message::Text(encoded.into())) {
                Ok(()) => Ok(()),
                Err(tungstenite::Error::Io(error))
                    if error.kind() == std::io::ErrorKind::WouldBlock =>
                {
                    Ok(())
                }
                Err(error) => Err(error.into()),
            }
        })();
        if result.is_err() {
            self.close();
        }
        result
    }

    pub fn generation(&self) -> Uuid {
        self.generation
    }
    /// No background queue: at most one bounded control frame is returned per
    /// call. Partial frames stay in tungstenite through WouldBlock/TimedOut.
    pub fn poll(&mut self) -> Result<Option<Event>, SurfaceProviderError> {
        let result = (|| {
            self.owner.check_record()?;
            self.flush()?;
            let mut event = self.receive()?;
            if let Some(event) = &mut event {
                self.ledger.apply(event)?;
            }
            Ok(event)
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    /// Queue once; only a matching Offered{accepted:true} permits transfer.
    /// WouldBlock retains tungstenite's bounded pending write, never resend it.
    pub fn submit(
        &mut self,
        offer: crate::tmux_graphics::surface_provider_offer::Submission,
    ) -> Result<(), SurfaceProviderError> {
        if self.closed {
            return Err(SurfaceProviderError::Closed);
        }
        if let Err(error) = self.owner.check_record() {
            self.close();
            return Err(error.into());
        }
        self.ledger.submit(&offer, self.generation)?;
        match self.socket.send(Message::Text(offer.encoded.into())) {
            Ok(()) => Ok(()),
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                Ok(())
            }
            Err(error) => {
                self.close();
                Err(error.into())
            }
        }
    }
    fn flush(&mut self) -> Result<(), SurfaceProviderError> {
        if self.closed {
            return Err(SurfaceProviderError::Closed);
        }
        match self.socket.flush() {
            Ok(()) => Ok(()),
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }
    fn receive(&mut self) -> Result<Option<Event>, SurfaceProviderError> {
        if self.closed {
            return Err(SurfaceProviderError::Closed);
        }
        self.owner.check_record()?;
        match self.socket.read() {
            Ok(Message::Text(text)) => {
                self.owner.check_record()?;
                Ok(Some(Event::parse(text.as_bytes(), self.generation)?))
            }
            Ok(Message::Ping(_) | Message::Pong(_)) => Ok(None),
            Ok(Message::Close(_)) => Err(SurfaceProviderError::Closed),
            Ok(_) => Err(SurfaceProviderError::Protocol),
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.ledger = Default::default();
        let _ = self.socket.get_mut().shutdown(Shutdown::Both);
    }
}
impl Drop for SurfaceProvider {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(all(test, unix))]
#[path = "surface_provider_tests.rs"]
mod tests;
