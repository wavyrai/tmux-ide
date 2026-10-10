//! Connection-lifetime state and the worker loop that drives it: handshake and
//! codec negotiation, boot-fenced snapshot/surface projection, the single
//! in-flight API lease, and health checks. Nothing here replays or reconnects.

use crate::{
    Error, Result,
    event::{ClientEvent, deliver},
    frame::FrameReader,
    handle::Command,
    limits::{
        COMMAND_TIMEOUT, LIVENESS_TIMEOUT, MAX_RESPONSE_BYTES, PING_TIMEOUT, POLL, SLOW_REQUEST,
        TIMEOUT,
    },
    method::Method,
    options::ConnectOptions,
    protocol::{endpoint::*, *},
    queue::CommandReceiver,
    surface_images::ImageStore,
    transport::Stream,
};
use crossbeam_channel::{Sender, TryRecvError};
use serde_json::Value;
use std::{
    io::Write,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(crate) struct Pending {
    pub(crate) id: String,
    pub(crate) bytes: Vec<u8>,
    pub(crate) started: Instant,
}
fn supports_surface_interest(welcome: &EndpointServerWelcome) -> bool {
    ["surface_interest", "presentation_effects_fence"]
        .iter()
        .all(|cap| welcome.capabilities.iter().any(|c| c == cap))
        && Method::ClientShellSurfaceSet.advertised_in(&welcome.methods)
}

/// Optional surface encodings this connection may receive. The hello requests
/// all of them because it precedes the welcome, as upstream's own client does;
/// only the ones the welcome advertises are accepted afterwards.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SurfaceEncodings {
    pub(crate) reuse: bool,
    pub(crate) delta: bool,
    pub(crate) scroll: bool,
}

impl From<&EndpointServerWelcome> for SurfaceEncodings {
    fn from(welcome: &EndpointServerWelcome) -> Self {
        let advertised = |capability| welcome.capabilities.iter().any(|c| c == capability);
        Self {
            reuse: advertised(surface_reuse::CAPABILITY),
            delta: advertised(surface_delta::CAPABILITY),
            scroll: advertised(surface_scroll::CAPABILITY),
        }
    }
}

pub(crate) struct Health {
    pub(crate) received: Instant,
    /// The outstanding ping, and the instant it fails the link unanswered.
    pub(crate) ping: Option<(Instant, Instant)>,
}
impl Health {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            received: now,
            ping: None,
        }
    }
    pub(crate) fn received(&mut self, now: Instant) {
        self.received = now;
        self.ping = None;
    }
    /// Ask the link to prove itself within `LIVENESS_TIMEOUT`, sooner than a
    /// quiet link's routine ping. Returns whether a new ping must be sent; one
    /// already outstanding only has its deadline brought forward.
    pub(crate) fn probe(&mut self, now: Instant) -> bool {
        let deadline = now + LIVENESS_TIMEOUT;
        match &mut self.ping {
            Some((_, due)) => {
                *due = (*due).min(deadline);
                false
            }
            None => {
                self.ping = Some((now, deadline));
                true
            }
        }
    }
    pub(crate) fn tick(&mut self, now: Instant) -> Result<bool> {
        if self.ping.is_some_and(|(_, due)| now >= due) {
            tracing::warn!(category = "health_check", "client timeout");
            return Err(Error::HealthTimeout);
        }
        if self.ping.is_none()
            && now.saturating_duration_since(self.received) >= Duration::from_secs(5)
        {
            self.ping = Some((now, now + PING_TIMEOUT));
            return Ok(true);
        }
        Ok(false)
    }
}

pub(crate) struct Session {
    pub(crate) started: Instant,
    pub(crate) surface_active: bool,
    pub(crate) remote: bool,
    pub(crate) health: Option<Health>,
    pub(crate) welcome: Option<EndpointServerWelcome>,
    pub(crate) encodings: SurfaceEncodings,
    pub(crate) snapshot: Option<Arc<ClientShellSnapshot>>,
    pub(crate) surface: Option<Arc<PaneSurfaceFrame>>,
    pub(crate) images: ImageStore,
    pub(crate) pending: Option<Pending>,
}

impl Session {
    pub(crate) fn new(surface_active: bool, remote: bool) -> Self {
        Self {
            started: Instant::now(),
            surface_active,
            remote,
            health: None,
            welcome: None,
            encodings: SurfaceEncodings::default(),
            snapshot: None,
            surface: None,
            images: ImageStore::default(),
            pending: None,
        }
    }

    pub(crate) fn check_timeouts(&self) -> Result<()> {
        if self.snapshot.is_none() && self.started.elapsed() > TIMEOUT {
            tracing::warn!(category = "initial_snapshot", "client timeout");
            return Err(Error::HandshakeTimeout);
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.started.elapsed() > COMMAND_TIMEOUT)
        {
            tracing::warn!(category = "request", "client timeout; request not replayed");
            return Err(Error::RequestTimeout);
        }
        Ok(())
    }

    pub(crate) fn rejection_reason(&self, command: &Command) -> Option<Error> {
        if self
            .snapshot
            .as_ref()
            .is_none_or(|s| s.boot_id != command.boot_id)
        {
            Some(Error::CommandBoot)
        } else if let Some(request) = &command.request
            && self
                .welcome
                .as_ref()
                .is_none_or(|w| !request.method.advertised_in(&w.methods))
        {
            Some(Error::UnsupportedMethod)
        } else if let Some(request) = &command.request
            && request.method == Method::ClientShellSurfaceSet
            && self
                .welcome
                .as_ref()
                .is_none_or(|w| !supports_surface_interest(w))
        {
            Some(Error::UnsupportedSurfaceInterest)
        } else {
            None
        }
    }
}

/// What the caller's handle tells the worker between commands.
#[derive(Clone, Copy)]
pub(crate) struct Signals<'a> {
    /// Ends the connection without flushing or replaying anything.
    pub(crate) stop: &'a AtomicBool,
    /// Asks an SSH link for an immediate health probe.
    pub(crate) liveness: &'a AtomicBool,
}

pub(crate) fn run_connection(
    mut stream: Stream,
    options: ConnectOptions,
    surface_active: bool,
    remote: bool,
    commands: CommandReceiver,
    tx: &Sender<ClientEvent>,
    signals: Signals<'_>,
) -> Result<()> {
    let Signals { stop, liveness } = signals;
    stream.set_read_timeout(Some(POLL))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    let hello = EndpointClientHello {
        generation: ENDPOINT_PROTOCOL_GENERATION,
        cell_width_px: options.cell_width_px,
        cell_height_px: options.cell_height_px,
        surface_size: options.surface_size,
        pixel_mouse: false,
        direct_graphics: false,
        endpoint_keybindings: false,
        mouse_capture: false,
        surface_active,
        surface_reuse: true,
        surface_delta: true,
        surface_scroll: true,
        snapshot_codecs: vec![SNAPSHOT_CODEC_V1.into()],
        surface_codecs: vec![SURFACE_CODEC_V1.into()],
        input_codecs: vec![INPUT_CODEC_V1.into()],
        blob_codecs: vec![BLOB_CODEC_V1.into()],
    };
    write_message(
        &mut stream,
        &ClientMessage::EndpointControl {
            kind: ENDPOINT_HELLO_KIND.into(),
            data: serde_json::to_string(&hello)?,
        },
        MAX_FRAME_SIZE,
    )?;
    let mut reader = FrameReader::new();
    let mut session = Session::new(surface_active, remote);
    let mut queued: Option<Command> = None;
    while !stop.load(Ordering::Acquire) {
        session.check_timeouts()?;
        let partial_image = queued
            .as_ref()
            .and_then(|c| c.image.as_ref())
            .is_some_and(|image| image.writer.offset > 0);
        if let Some(image) = queued.as_ref().and_then(|c| c.image.as_ref()) {
            image.writer.check_timeout()?;
            if partial_image && image.lease.cancelled.load(Ordering::Acquire) {
                return Err(Error::ClipboardImageCancelled);
            }
        }
        // A probe is a frame too: never insert one into a partial image frame.
        // Preparation does not suppress probes; actual writes have their own deadline.
        // A liveness request waits for the same boundary rather than being lost.
        if !partial_image && let Some(health) = &mut session.health {
            let now = Instant::now();
            let probe = liveness.swap(false, Ordering::AcqRel) && health.probe(now);
            if health.tick(now)? || probe {
                write_message(
                    &mut stream,
                    &ClientMessage::EndpointControl {
                        kind: "endpoint.health.ping.v1".into(),
                        data: String::new(),
                    },
                    MAX_FRAME_SIZE,
                )?;
            }
        }
        // Bound the batch so continuous input cannot starve reads.
        for _ in 0..16 {
            // Fence new commands on inbound state, but continue a frame already
            // started: the peer may be waiting to read it before finishing its own.
            if reader.started.is_some() && !partial_image {
                break;
            }
            let Some(mut command) = queued.take().or_else(|| commands.try_recv().ok()) else {
                break;
            };
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            if let Some(reason) = session.rejection_reason(&command) {
                tracing::debug!(category = "session_policy", "command rejected");
                deliver(
                    tx,
                    ClientEvent::CommandRejected {
                        request_id: command.request.map(|request| request.id),
                        reason,
                    },
                    stop,
                )?;
                continue;
            }
            // The daemon has one API command lease per connection. Keep FIFO order,
            // including input behind a waiting request, without draining the bound.
            if command.request.is_some() && session.pending.is_some() {
                queued = Some(command);
                break;
            }
            if let Some(image) = &mut command.image {
                if image.lease.cancelled.load(Ordering::Acquire) {
                    if image.writer.offset > 0 {
                        return Err(Error::ClipboardImageCancelled);
                    }
                    continue;
                }
                if command.bytes.is_empty() {
                    match image.receiver.try_recv() {
                        Ok(bytes) => command.bytes = bytes,
                        Err(TryRecvError::Empty) => {
                            if image.lease.reserved_at.elapsed() >= COMMAND_TIMEOUT {
                                image.lease.cancelled.store(true, Ordering::Release);
                                deliver(
                                    tx,
                                    ClientEvent::CommandRejected {
                                        request_id: None,
                                        reason: Error::ClipboardImagePreparationTimeout,
                                    },
                                    stop,
                                )?;
                                continue;
                            }
                            queued = Some(command);
                            break;
                        }
                        Err(TryRecvError::Disconnected) => continue,
                    }
                }
                stream.set_write_timeout(Some(POLL))?;
                let finished = image.writer.poll(&mut stream, &command.bytes)?;
                stream.set_write_timeout(Some(Duration::from_secs(1)))?;
                if !finished {
                    queued = Some(command);
                }
                // Even a successful bounded write yields to the inbound reader.
                break;
            }
            stream.write_all(&command.bytes)?;
            if let Some(request) = command.request {
                tracing::trace!(category = "api", "request sent");
                session.pending = Some(Pending {
                    id: request.id,
                    bytes: Vec::new(),
                    started: Instant::now(),
                });
            }
        }
        // Commands left behind by the batch bound must not wait out a poll;
        // ones fenced by a request, an image, or a partial frame do.
        let timeout = if queued.is_none() && reader.started.is_none() && !commands.is_empty() {
            Duration::ZERO
        } else {
            POLL
        };
        if !commands.wait(&stream, timeout)? {
            continue;
        }
        let message = match reader.poll_batch(&mut stream) {
            // Daemons before the endpoint protocol cannot decode the hello and
            // close without a word. SSH discovery vets the remote binary first,
            // so only a local close this early is read as an outdated daemon.
            Err(Error::SocketClosed) if session.welcome.is_none() && !remote => {
                return Err(Error::ClosedBeforeWelcome);
            }
            result => result?,
        };
        let Some(message) = message else {
            continue;
        };
        session.handle_message(message, |event| deliver(tx, event, stop))?;
    }
    // No queued commands are flushed on cancellation and nothing is replayed.
    Ok(())
}

impl Session {
    pub(crate) fn handle_message(
        &mut self,
        message: ServerMessage,
        mut emit: impl FnMut(ClientEvent) -> Result<()>,
    ) -> Result<()> {
        if let Some(health) = &mut self.health {
            health.received(Instant::now());
        }
        let Self {
            surface_active,
            remote,
            health,
            welcome,
            encodings,
            snapshot,
            surface,
            images,
            pending,
            ..
        } = self;
        if welcome.is_none() {
            let (kind, data) = match message {
                ServerMessage::EndpointControl { kind, data } => (kind, data),
                // Only a daemon from before the endpoint protocol answers the
                // hello with its legacy welcome.
                ServerMessage::Welcome { .. } => return Err(Error::LegacyDaemon),
                _ => return Err(Error::ExpectedWelcome),
            };
            if kind != ENDPOINT_WELCOME_KIND {
                return Err(Error::WelcomeKind);
            }
            let w: EndpointServerWelcome = serde_json::from_str(&data)?;
            // A rejection carries the daemon's own generation, so a refused
            // generation still says which side is older.
            if w.generation != ENDPOINT_PROTOCOL_GENERATION {
                return Err(Error::EndpointGeneration {
                    generation: w.generation,
                    server_version: w.server_version,
                });
            }
            if let Some(error) = &w.error {
                return Err(Error::WelcomeRejected {
                    code: error.code.clone(),
                    message: error.message.clone(),
                });
            }
            if w.snapshot_codec != SNAPSHOT_CODEC_V1
                || w.surface_codec != SURFACE_CODEC_V1
                || w.input_codec != INPUT_CODEC_V1
                || w.blob_codec != BLOB_CODEC_V1
            {
                return Err(Error::IncompatibleCodecs);
            }
            if (*remote || !*surface_active) && !supports_surface_interest(&w) {
                return Err(Error::MissingSurfaceInterest {
                    server_version: w.server_version,
                });
            }
            if *remote {
                if !w.capabilities.iter().any(|c| c == "health_check") {
                    return Err(Error::MissingHealthCheck {
                        server_version: w.server_version,
                    });
                }
                *health = Some(Health::new(Instant::now()));
            }
            *encodings = SurfaceEncodings::from(&w);
            emit(ClientEvent::Connected(w.clone()))?;
            tracing::info!(?encodings, "endpoint handshake accepted");
            *welcome = Some(w);
            return Ok(());
        }
        match message {
            ServerMessage::EndpointControl { kind, data } if kind == ENDPOINT_SNAPSHOT_KIND => {
                let next: ClientShellSnapshot = serde_json::from_str(&data)?;
                if next.boot_id.is_empty()
                    || snapshot
                        .as_ref()
                        .is_some_and(|s| s.boot_id != next.boot_id || next.revision < s.revision)
                {
                    return Err(Error::SnapshotIdentity);
                }
                let next = Arc::new(next);
                if snapshot.is_none() {
                    tracing::debug!("initial snapshot ready");
                }
                let revision_changed = snapshot
                    .as_ref()
                    .is_none_or(|s| s.revision != next.revision);
                *snapshot = Some(next.clone());
                emit(ClientEvent::Snapshot(next.clone()))?;
                if revision_changed
                    && let Some(current) = surface
                        .as_ref()
                        .filter(|current| current.projection_revision == next.revision)
                {
                    if images.show() {
                        emit(ClientEvent::SurfaceImages(images.published()))?;
                    }
                    emit(ClientEvent::Surface(current.clone()))?;
                }
            }
            // Optional encodings expand into the same atomic surface and patch
            // paths, so revision fencing and validation stay in one place.
            ServerMessage::EndpointControl { kind, data }
                if kind == surface_scroll::MESSAGE_KIND =>
            {
                if !encodings.scroll {
                    return Err(Error::SurfaceEncodingNotNegotiated);
                }
                let scroll = surface_scroll::decode(&data)?;
                let current = surface.as_mut().ok_or(Error::PatchBeforeBaseline)?;
                Arc::make_mut(current).apply_scroll_patch(scroll)?;
                emit_patched(snapshot.as_deref(), current, images, &mut emit)?;
            }
            ServerMessage::EndpointControl { kind, data }
                if kind == surface_delta::MESSAGE_KIND =>
            {
                if !encodings.delta {
                    return Err(Error::SurfaceEncodingNotNegotiated);
                }
                let delta = surface_delta::decode(&data)?;
                let base = surface
                    .as_deref()
                    .ok_or(Error::EncodedSurfaceBeforeBaseline)?;
                let next = delta.reconstruct(base)?;
                accept_surface(next, snapshot.as_deref(), surface, images, &mut emit)?;
            }
            ServerMessage::EndpointControl { kind, data }
                if kind == surface_reuse::MESSAGE_KIND =>
            {
                if !encodings.reuse {
                    return Err(Error::SurfaceEncodingNotNegotiated);
                }
                let reuse = surface_reuse::decode(&data)?;
                let base = surface
                    .as_deref()
                    .ok_or(Error::EncodedSurfaceBeforeBaseline)?;
                let next = reuse.reconstruct(base)?;
                accept_surface(next, snapshot.as_deref(), surface, images, &mut emit)?;
            }
            ServerMessage::EndpointControl { .. } => {} // Unknown optional named controls are ignored.
            ServerMessage::PaneSurface(next) => {
                accept_surface(next, snapshot.as_deref(), surface, images, &mut emit)?;
            }
            ServerMessage::PaneSurfacePatch(patch) => {
                let current = surface.as_mut().ok_or(Error::PatchBeforeBaseline)?;
                Arc::make_mut(current).apply_patch(patch)?;
                emit_patched(snapshot.as_deref(), current, images, &mut emit)?;
            }
            ServerMessage::ClientShellEndpointResponseChunk {
                boot_id,
                request_id,
                final_chunk,
                data,
            } => {
                if snapshot.as_ref().is_none_or(|s| s.boot_id != boot_id) {
                    return Err(Error::ResponseBoot);
                }
                let total = pending.as_ref().map_or(0, |p| p.bytes.len());
                if data.len() > MAX_RESPONSE_BYTES.saturating_sub(total) {
                    return Err(Error::ResponseLimit);
                }
                let p = pending
                    .as_mut()
                    .filter(|p| p.id == request_id)
                    .ok_or(Error::UnsolicitedResponse)?;
                p.bytes.extend(data);
                if final_chunk {
                    let p = pending.take().ok_or(Error::UnsolicitedResponse)?;
                    let response: Value = serde_json::from_slice(&p.bytes)?;
                    if response.get("id").and_then(Value::as_str) != Some(&request_id) {
                        return Err(Error::ResponseId);
                    }
                    let elapsed = p.started.elapsed();
                    let elapsed_ms = elapsed.as_millis() as u64;
                    let api_error = response.get("error").is_some_and(|error| !error.is_null());
                    if api_error {
                        tracing::warn!(elapsed_ms, "API request failed");
                    } else if elapsed > SLOW_REQUEST {
                        tracing::warn!(elapsed_ms, api_error, "slow API request completed");
                    } else {
                        tracing::trace!(elapsed_ms, api_error, "API request completed");
                    }
                    emit(ClientEvent::Response {
                        request_id,
                        response,
                    })?;
                }
            }
            ServerMessage::ServerShutdown { reason } => {
                return Err(Error::ServerShutdown(
                    reason.unwrap_or_else(|| "server shutdown".into()),
                ));
            }
            other => emit(ClientEvent::Message(other))?,
        }
        Ok(())
    }
}

/// Fences a complete surface on boot and revision, validates it, and retains it
/// as the baseline whether or not its projection is current.
fn accept_surface(
    mut next: PaneSurfaceFrame,
    snapshot: Option<&ClientShellSnapshot>,
    surface: &mut Option<Arc<PaneSurfaceFrame>>,
    images: &mut ImageStore,
    emit: &mut impl FnMut(ClientEvent) -> Result<()>,
) -> Result<()> {
    let s = snapshot.ok_or(Error::SurfaceBeforeSnapshot)?;
    if next.boot_id != s.boot_id
        || surface
            .as_ref()
            .is_some_and(|old| next.surface_revision <= old.surface_revision)
    {
        return Err(Error::SurfaceIdentity);
    }
    next.frame.validate()?;
    if let Some(popup) = &next.popup {
        popup.frame.validate()?;
    }
    let mut changed = images.receive(&mut next);
    let next = Arc::new(next);
    let shown = next.projection_revision == s.revision;
    if shown {
        changed |= images.show();
    }
    // Pixels precede the surface that places them.
    if changed {
        emit(ClientEvent::SurfaceImages(images.published()))?;
    }
    if shown {
        emit(ClientEvent::Surface(next.clone()))?;
    }
    *surface = Some(next);
    Ok(())
}

fn emit_patched(
    snapshot: Option<&ClientShellSnapshot>,
    current: &Arc<PaneSurfaceFrame>,
    images: &mut ImageStore,
    emit: &mut impl FnMut(ClientEvent) -> Result<()>,
) -> Result<()> {
    if snapshot.is_some_and(|s| s.revision == current.projection_revision) {
        // A patch keeps the scene, but emitting it releases what an older
        // surface on screen still held.
        if images.show() {
            emit(ClientEvent::SurfaceImages(images.published()))?;
        }
        emit(ClientEvent::Surface(current.clone()))?;
    }
    Ok(())
}
