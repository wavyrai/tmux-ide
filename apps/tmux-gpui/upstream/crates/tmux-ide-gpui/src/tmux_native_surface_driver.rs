//! macOS implementation of the native session's worker interface. The inbox is
//! bounded by both count and admitted native storage; the UI never waits on it.
use super::{Image, connection::Connection};
use gpui_apple::surface_rendezvous::{Registration, RegistrationAttempt};
use herdr_client::{
    tmux_graphics::surface_control::FallbackReason,
    tmux_native_session::surfaces::{self, Committed, Failure},
    tmux_stream::{Command, PaneStream},
};
use std::{
    sync::{
        Arc, Mutex, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_IMAGES: usize = 8;
const POLL: Duration = Duration::from_millis(8);
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native image mailbox unavailable")]
    Mailbox,
    #[error("native image control has no admitted pane")]
    Identity,
    #[error("native image driver lifecycle mismatch")]
    State,
    #[error("native image control exceeds its bound")]
    Bounds,
    #[error("native image control metadata failed")]
    Metadata(#[from] serde_json::Error),
    #[error("native image endpoint registration failed")]
    Platform(#[source] anyhow::Error),
}

/// One consumer, paired with one driver. A new connection must get a new pair.
pub struct Inbox {
    images: Arc<Mutex<Vec<Image>>>,
    live: Arc<AtomicBool>,
}
impl Inbox {
    /// None means contended; retry on the next UI update, never block rendering.
    /// Revocation also fences already-drained images and prepared paint items.
    pub fn drain(&self) -> Result<Option<Vec<Image>>, Error> {
        let mut images = match self.images.try_lock() {
            Ok(images) => images,
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Poisoned(_)) => return Err(Error::Mailbox),
        };
        if !self.live.load(Ordering::Acquire) {
            images.clear();
        }
        Ok(Some(std::mem::take(&mut *images)))
    }
}
impl Drop for Inbox {
    fn drop(&mut self) {
        // Publication can disappear before the transport observes cancellation.
        // Fence already-retained paint immediately, without waiting for either.
        self.live.store(false, Ordering::Release);
        if let Ok(mut images) = self.images.try_lock() {
            images.clear();
        }
    }
}

pub struct Driver {
    generation: Uuid,
    desired_nonce: Option<Uuid>,
    retired: Vec<Connection>,
    publication: Arc<AtomicBool>,
    registration: Option<RegistrationAttempt>,
    connection: Option<Connection>,
    images: Arc<Mutex<Vec<Image>>>,
    live: Arc<AtomicBool>,
    deadline: Option<Instant>,
    started: bool,
    fallback: bool,
    wake: Option<surfaces::WakeSender>,
}
impl Driver {
    /// Call only for a broker-negotiated same-host provider. This allocates no
    /// native endpoints until the worker invokes start after authenticated Ready.
    pub fn new(generation: Uuid) -> (Self, Inbox) {
        let images = Arc::new(Mutex::new(Vec::new()));
        let live = Arc::new(AtomicBool::new(false));
        let publication = Arc::new(AtomicBool::new(true));
        let inbox = Inbox {
            images: Arc::clone(&images),
            live: Arc::clone(&publication),
        };
        (
            Self {
                generation,
                desired_nonce: None,
                retired: Vec::new(),
                publication,
                registration: None,
                connection: None,
                images,
                live,
                deadline: None,
                started: false,
                fallback: false,
                wake: None,
            },
            inbox,
        )
    }
    fn invalidate(&mut self) {
        self.live.store(false, Ordering::Release);
        if let Ok(mut images) = self.images.try_lock() {
            images.clear();
        }
    }
    fn send(stream: &PaneStream, json: String) -> Result<(), Failure> {
        stream.try_send(Command::from_json(json)?)?;
        Ok(())
    }
    fn fall_back(&mut self, reason: FallbackReason, stream: &PaneStream) -> Result<(), Failure> {
        self.fallback = true;
        self.registration = None;
        self.deadline = None;
        self.invalidate();
        if let Some(connection) = &mut self.connection {
            Self::send(stream, connection.fallback(reason)?)?;
        }
        Ok(())
    }
}
impl surfaces::Driver for Driver {
    fn set_waker(&mut self, wake: surfaces::WakeSender) {
        self.wake = Some(wake);
    }
    fn start(&mut self, stream: &PaneStream) -> Result<(), Failure> {
        if self.started {
            return Err(Error::State.into());
        }
        self.started = true;
        Self::send(
            stream,
            serde_json::to_string(&serde_json::json!({
                "type":"terminal-surface-watch", "version":1, "generation":self.generation,
            }))
            .map_err(Error::Metadata)?,
        )
    }

    fn accept(
        &mut self,
        raw: &str,
        committed: &Committed,
        stream: &PaneStream,
    ) -> Result<(), Failure> {
        if raw.len() > 16 * 1024 {
            return Err(Error::Bounds.into());
        }
        #[derive(serde::Deserialize)]
        struct Header<'a> {
            #[serde(rename = "type")]
            kind: &'a str,
            pane: Option<&'a str>,
            #[serde(rename = "connectionNonce")]
            nonce: Option<Uuid>,
        }
        let header: Header<'_> = serde_json::from_str(raw).map_err(Error::Metadata)?;
        if header.kind == "terminal-surface-available" {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Available {
                #[serde(rename = "type")]
                kind: String,
                version: u8,
                generation: Uuid,
                connection_nonce: Option<Uuid>,
            }
            let event: Available = serde_json::from_str(raw).map_err(Error::Metadata)?;
            if event.kind != "terminal-surface-available"
                || event.version != 1
                || event.generation != self.generation
                || event.connection_nonce.is_some_and(|nonce| nonce.is_nil())
            {
                return Err(Error::Identity.into());
            }
            if self.desired_nonce == event.connection_nonce {
                return Ok(());
            }
            self.invalidate();
            self.registration = None;
            if let Some(mut connection) = self.connection.take() {
                // Availability follows the server's revocation. Retain only the
                // original ACK route; do not echo a second fallback after pruning.
                let _ = connection.fallback(FallbackReason::Unsupported)?;
                self.retired.push(connection);
            }
            self.desired_nonce = event.connection_nonce;
            self.fallback = false;
            return self.poll(Instant::now(), committed, stream);
        }
        if header.kind == "terminal-surface-fallback"
            && let Some(old) = self
                .retired
                .iter_mut()
                .find(|connection| Some(connection.nonce()) == header.nonce)
        {
            old.accept_fallback(raw.as_bytes())?;
            return self.poll(Instant::now(), committed, stream);
        }
        let connection = self.connection.as_mut().ok_or(Error::State)?;
        let result = match header.kind {
            "terminal-surface-peer" => connection.accept_peer(raw.as_bytes()),
            "terminal-surface-offer" => {
                let pane = header.pane.ok_or(Error::Identity)?;
                let current = committed.get(pane).ok_or(Error::Identity)?;
                connection.admit(raw.as_bytes(), pane, current, Instant::now())
            }
            "terminal-surface-fallback" => {
                connection.accept_fallback(raw.as_bytes())?;
                self.fallback = true;
                self.invalidate();
                Ok(())
            }
            _ => return Err(Error::State.into()),
        };
        if result.is_err() {
            self.fall_back(FallbackReason::Identity, stream)?;
        }
        self.poll(Instant::now(), committed, stream)
    }
    fn poll(
        &mut self,
        now: Instant,
        committed: &Committed,
        stream: &PaneStream,
    ) -> Result<(), Failure> {
        if !self.started {
            return Err(Error::State.into());
        }
        if !self.publication.load(Ordering::Acquire) {
            self.close();
            return Ok(());
        }
        for connection in &mut self.retired {
            for _ in 0..MAX_IMAGES {
                let Some(frame) = connection.next_retirement()? else {
                    break;
                };
                Self::send(stream, frame)?;
            }
        }
        self.retired.retain_mut(|connection| {
            if connection.reserved_bytes() == 0 {
                connection.close();
                false
            } else {
                true
            }
        });
        if !self.fallback
            && self.desired_nonce.is_some()
            && self.connection.is_none()
            && self.registration.is_none()
            && self.retired.len() < MAX_IMAGES
        {
            self.registration = match Registration::begin() {
                Ok(attempt) => Some(attempt),
                Err(_) => return self.fall_back(FallbackReason::Unsupported, stream),
            };
            self.live = Arc::new(AtomicBool::new(true));
        }
        let registration = match self
            .registration
            .as_mut()
            .map(|attempt| attempt.poll())
            .transpose()
        {
            Ok(value) => value.flatten(),
            Err(_) => return self.fall_back(FallbackReason::Unsupported, stream),
        };
        if let Some(registration) = registration {
            let mut connection = match Connection::with_nonce(
                self.generation,
                self.desired_nonce.ok_or(Error::State)?,
                registration,
            ) {
                Ok(connection) => connection,
                Err(_) => return self.fall_back(FallbackReason::Storage, stream),
            };
            connection.set_waker(self.wake.clone().ok_or(Error::State)?);
            Self::send(stream, connection.receiver_frame()?)?;
            self.connection = Some(connection);
            self.registration = None;
        }
        if let Some(connection) = &mut self.connection
            && let Some(frame) = connection.poll(now)?
        {
            Self::send(stream, frame)?;
            self.fallback = true;
            self.invalidate();
        }
        if !self.fallback {
            let received = if let Some(connection) = &mut self.connection {
                match self.images.try_lock() {
                    Ok(mut images) if images.len() < MAX_IMAGES => connection
                        .receive(now, |pane| committed.get(pane).cloned())
                        .map(|image| {
                            if let Some(mut image) = image {
                                image.live = Arc::clone(&self.live);
                                image.publication = Arc::clone(&self.publication);
                                images.push(image);
                            }
                        }),
                    Ok(_) | Err(TryLockError::WouldBlock) => Ok(()),
                    Err(TryLockError::Poisoned(_)) => return Err(Error::Mailbox.into()),
                }
            } else {
                Ok(())
            };
            if received.is_err() {
                self.fall_back(FallbackReason::Storage, stream)?;
            }
        }
        if let Some(connection) = &mut self.connection {
            // Bound work per tick even when the renderer retires a whole scene.
            for _ in 0..MAX_IMAGES {
                let Some(frame) = connection.next_retirement()? else {
                    break;
                };
                Self::send(stream, frame)?;
            }
        }
        self.deadline = if self.registration.is_some()
            || self.connection.as_ref().is_some_and(Connection::waiting)
        {
            Some(now + POLL)
        } else {
            None
        };
        Ok(())
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn close(&mut self) {
        // Suppress ACKs before releasing queued images and their storage leases.
        if let Some(connection) = &mut self.connection {
            connection.close();
        }
        self.invalidate();
        self.publication.store(false, Ordering::Release);
        for connection in &mut self.retired {
            connection.close();
        }
        self.retired.clear();
        self.desired_nonce = None;
        self.registration = None;
        self.connection = None;
        self.deadline = None;
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        surfaces::Driver::close(self);
    }
}

#[cfg(test)]
#[path = "tmux_native_surface_inbox_tests.rs"]
mod tests;
