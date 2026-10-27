//! Drains the native terminal stream off the UI thread and coalesces committed snapshots.
//! Ready means authenticated transport readiness; it never grants input authority.
use crate::{
    tmux_delivery::Snapshot,
    tmux_graphics::{self, Graphics, GraphicsUpdate, ImageChunk, KeyedPlacement},
    tmux_stream::{self, Command, ConnectOptions, PaneStream, Ready},
    tmux_terminal::{self, Outcome, TerminalState},
};
use serde_json::value::RawValue;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    thread,
    time::Instant,
};

#[path = "tmux_native_session_local.rs"]
mod local;

#[path = "tmux_native_session_surfaces.rs"]
pub mod surfaces;

const GRAPHICS_BYTES: usize = 8 * 1024 * 1024;
const GRAPHICS_COUNT: usize = 32;
const CONTROL_COUNT: usize = 32;
const CONTROL_BYTES: usize = 4 * 1024 * 1024;

#[derive(thiserror::Error)]
pub enum Error {
    #[error("native terminal transport failed")]
    Transport(#[from] tmux_stream::Error),
    #[error("native terminal state failed")]
    Terminal(#[from] tmux_terminal::Error),
    #[error("native terminal acknowledgement encoding failed")]
    Ack(#[source] serde_json::Error),
    #[error("native terminal control backlog exceeded bounds")]
    ControlBacklog,
    #[error("native graphics failed")]
    Graphics(#[from] tmux_graphics::Error),
    #[error("native graphics backlog exceeded bounds")]
    GraphicsBacklog,
    #[error("native graphics capability not offered")]
    GraphicsDisabled,
    #[error("native surface platform owner failed")]
    NativeSurface(#[source] surfaces::Failure),
    #[error("native terminal session cancelled")]
    Cancelled,
    #[error("native terminal worker stopped")]
    WorkerStopped,
    #[error("native terminal mailbox unavailable")]
    Mailbox,
    #[error("native terminal worker could not start")]
    Spawn(#[source] std::io::Error),
}

impl std::fmt::Debug for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, formatter)
    }
}

#[derive(Clone, Debug)]
pub enum Status {
    Connecting,
    Ready(Arc<Ready>),
    Failed(Arc<Error>),
    Cancelled,
}

/// Identity of the exact validated canonical commit, not an authority lease.
#[derive(Debug)]
pub struct CommittedIdentity {
    pub generation: String,
    pub incarnation: String,
    pub delivery_nonce: String,
    pub canonical_revision: u64,
    pub canonical_state_hash: String,
}

#[derive(Debug)]
pub struct CommittedPane {
    /// None records a committed tombstone and must never authorize terminal input.
    pub snapshot: Option<Arc<Snapshot>>,
    pub identity: Arc<CommittedIdentity>,
}

pub struct PaneUpdate {
    pub identity: Arc<CommittedIdentity>,
    pub snapshot: Option<Arc<Snapshot>>,
    pub changed_rows: Vec<usize>,
}

pub enum GraphicsEvent {
    Chunk(ImageChunk),
    Invalidate(Vec<String>),
}
/// Placements are tied to the exact committed snapshot, never input authority.
pub struct PaneGraphics {
    pub identity: Arc<CommittedIdentity>,
    pub placements: Vec<KeyedPlacement>,
}
pub struct Updates {
    pub materializing: BTreeSet<String>,
    pub status: Status,
    pub panes: BTreeMap<String, PaneUpdate>,
    pub controls: Vec<Box<RawValue>>,
    pub graphics: Vec<GraphicsEvent>,
    pub graphics_placements: BTreeMap<String, Arc<PaneGraphics>>,
    pub cell_pixels: bool,
    pub precise_cell_pixels: bool,
}

struct Pending {
    committed: Arc<CommittedPane>,
    rows: BTreeSet<usize>,
}

struct Mailbox {
    materializing: BTreeSet<String>,
    status: Status,
    retired: bool,
    current: BTreeMap<String, Arc<CommittedPane>>,
    pending: BTreeMap<String, Pending>,
    controls: Vec<Box<RawValue>>,
    control_bytes: usize,
    graphics: Vec<GraphicsEvent>,
    graphics_bytes: usize,
    graphics_placements: BTreeMap<String, Arc<PaneGraphics>>,
    cell_pixels: bool,
    precise_cell_pixels: bool,
}

impl Mailbox {
    fn new() -> Self {
        Self {
            materializing: BTreeSet::new(),
            status: Status::Connecting,
            retired: false,
            current: BTreeMap::new(),
            pending: BTreeMap::new(),
            controls: Vec::new(),
            control_bytes: 0,
            graphics: Vec::new(),
            graphics_bytes: 0,
            graphics_placements: BTreeMap::new(),
            cell_pixels: false,
            precise_cell_pixels: false,
        }
    }

    fn retire(&mut self, status: Status) {
        if self.retired {
            return;
        }
        self.retired = true;
        self.status = status;
        self.current.clear();
        self.materializing.clear();
        self.pending.clear();
        self.controls.clear();
        self.control_bytes = 0;
        self.graphics.clear();
        self.graphics_bytes = 0;
        self.graphics_placements.clear();
        self.cell_pixels = false;
        self.precise_cell_pixels = false;
    }

    fn local_graphics_room(&self) -> bool {
        // Reserve a chunk plus the bounded invalidations it can produce.
        self.graphics.len() + 2 <= GRAPHICS_COUNT
            && self.graphics_bytes + tmux_graphics::CHUNK_BYTES + 512 + 256 * 32 <= GRAPHICS_BYTES
    }

    fn graphics_event(&mut self, event: GraphicsEvent) -> Result<(), Error> {
        let bytes = match &event {
            GraphicsEvent::Chunk(chunk) => chunk.bytes.len() + 512,
            GraphicsEvent::Invalidate(digests) => digests.iter().map(String::len).sum(),
        };
        if self.retired {
            return Err(Error::Cancelled);
        }
        if self.graphics.len() >= GRAPHICS_COUNT || bytes > GRAPHICS_BYTES - self.graphics_bytes {
            return Err(Error::GraphicsBacklog);
        }
        self.graphics_bytes += bytes;
        self.graphics.push(event);
        Ok(())
    }

    fn commit(&mut self, pane: String, committed: Arc<CommittedPane>, changed_rows: Vec<usize>) {
        if committed
            .snapshot
            .as_ref()
            .is_none_or(|s| s.history.is_complete())
        {
            self.materializing.remove(&pane);
        }
        let height = committed
            .snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.grid.len());
        self.current.insert(pane.clone(), Arc::clone(&committed));
        let pending = self.pending.entry(pane).or_insert_with(|| Pending {
            committed: Arc::clone(&committed),
            rows: BTreeSet::new(),
        });
        pending
            .rows
            .extend(changed_rows.into_iter().filter(|row| *row < height));
        pending.rows.retain(|row| *row < height);
        pending.committed = committed;
    }
}

/// One connection's native state. Old handles cannot publish into a successor's mailbox.
pub struct NativeSession {
    graphics_missing: crossbeam_channel::Sender<Vec<String>>,
    graphics_drained: crossbeam_channel::Sender<()>,
    stream: Arc<PaneStream>,
    shared: Arc<Mutex<Mailbox>>,
}

impl NativeSession {
    pub fn spawn(options: ConnectOptions, workspace: String) -> Result<Self, Error> {
        Self::spawn_offered(options, workspace, false, None, false, false)
    }

    /// Observe one read-only pane's canonical cells without building a window
    /// presentation. The trusted broker must have offered capability 109.
    pub fn spawn_cell_observer(options: ConnectOptions, workspace: String) -> Result<Self, Error> {
        if options.descriptor.effective_viewer_mode != tmux_stream::ViewerMode::ReadOnly
            || options.descriptor.panes.len() != 1
        {
            return Err(Error::Terminal(tmux_terminal::Error::Identity));
        }
        Self::spawn_offered(options, workspace, false, None, true, false)
    }

    /// The trusted broker must have offered capability 101 on this exact issued stream.
    /// This records the offer, not a new negotiated flag: graphics state confirms support.
    pub fn spawn_with_graphics(options: ConnectOptions, workspace: String) -> Result<Self, Error> {
        Self::spawn_offered(options, workspace, true, None, false, false)
    }

    pub fn spawn_with_local_images(
        options: ConnectOptions,
        workspace: String,
        root: tmux_graphics::LocalImages,
    ) -> Result<Self, Error> {
        if !root.validate() {
            return Err(Error::Graphics(tmux_graphics::Error::Identity));
        }
        Self::spawn_offered(options, workspace, true, Some(root), false, false)
    }

    pub(crate) fn spawn_offered(
        options: ConnectOptions,
        workspace: String,
        graphics_enabled: bool,
        local_images: Option<tmux_graphics::LocalImages>,
        binary_cells: bool,
        alternate_screen_projection: bool,
    ) -> Result<Self, Error> {
        Self::spawn_configured(
            options,
            workspace,
            graphics_enabled,
            local_images,
            binary_cells,
            alternate_screen_projection,
            None,
        )
    }

    /// The trusted broker must have negotiated a same-host native provider for
    /// this issued stream. A loopback URL alone does not authorize this entry.
    /// The driver is started by the model worker only after authenticated Ready.
    pub fn spawn_with_surfaces(
        options: ConnectOptions,
        workspace: String,
        driver: Box<dyn surfaces::Driver>,
    ) -> Result<Self, Error> {
        Self::spawn_configured(options, workspace, true, None, false, false, Some(driver))
    }

    pub(crate) fn spawn_configured(
        options: ConnectOptions,
        workspace: String,
        graphics_enabled: bool,
        local_images: Option<tmux_graphics::LocalImages>,
        binary_cells: bool,
        alternate_screen_projection: bool,
        surfaces: Option<Box<dyn surfaces::Driver>>,
    ) -> Result<Self, Error> {
        let surfaces = surfaces.map(surfaces::Owner::new);
        if surfaces.is_some() && (options.remote_peer.is_some() || !graphics_enabled) {
            return Err(Error::GraphicsDisabled);
        }
        if options.remote_peer.is_some() && local_images.is_some() {
            return Err(Error::Graphics(tmux_graphics::Error::Identity));
        }
        if local_images
            .as_ref()
            .is_some_and(|root| !graphics_enabled || !root.validate())
        {
            return Err(Error::Graphics(tmux_graphics::Error::Identity));
        }
        let graphics = if graphics_enabled {
            Some(Graphics::new(
                options.descriptor.daemon_instance_id.clone(),
                options.descriptor.panes.clone(),
            )?)
        } else {
            None
        };
        let (graphics_missing, missing) = crossbeam_channel::bounded(8);
        let (graphics_drained, drained) = crossbeam_channel::bounded(1);
        let state = TerminalState::new_offered(
            options.descriptor.daemon_instance_id.clone(),
            workspace,
            options.descriptor.panes.clone(),
            binary_cells,
            alternate_screen_projection,
        )?;
        let stream = Arc::new(PaneStream::spawn(options)?);
        let shared = Arc::new(Mutex::new(Mailbox::new()));
        let worker_stream = Arc::clone(&stream);
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("tmux-native-state".into())
            .spawn(move || {
                let _exit = WorkerExit {
                    shared: Arc::clone(&worker_shared),
                    stream: Arc::clone(&worker_stream),
                };
                if let Err(error) = run(
                    state,
                    graphics,
                    local_images,
                    (missing, drained),
                    &worker_stream,
                    &worker_shared,
                    surfaces,
                ) && let Ok(mut mailbox) = worker_shared.lock()
                {
                    mailbox.retire(Status::Failed(Arc::new(error)));
                }
            });
        if let Err(error) = worker {
            stream.cancel();
            return Err(Error::Spawn(error));
        }
        Ok(Self {
            stream,
            shared,
            graphics_missing,
            graphics_drained,
        })
    }

    /// Reports GUI cache eviction; requests are rebuilt only from current visible placements.
    pub fn graphics_missing(&self, digests: Vec<String>) -> Result<(), Error> {
        if digests.len() > 256
            || digests.iter().any(|d| {
                d.len() != 32
                    || !d
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(Error::Graphics(tmux_graphics::Error::Bounds));
        }
        if self.shared.lock().map_err(|_| Error::Mailbox)?.retired {
            return Err(Error::Cancelled);
        }
        self.graphics_missing
            .try_send(digests)
            .map_err(|_| Error::GraphicsBacklog)
    }

    /// Queuing never means the daemon accepted an input/lease command.
    pub fn try_send(&self, command: Command) -> Result<(), Error> {
        if self.shared.lock().map_err(|_| Error::Mailbox)?.retired {
            return Err(Error::Cancelled);
        }
        self.stream.try_send(command).map_err(Error::Transport)
    }

    /// Takes the latest pending snapshots and every ordered control frame exactly once.
    pub fn drain(&self) -> Result<Updates, Error> {
        let mut mailbox = self.shared.lock().map_err(|_| Error::Mailbox)?;
        let panes = std::mem::take(&mut mailbox.pending)
            .into_iter()
            .map(|(pane, pending)| {
                (
                    pane,
                    PaneUpdate {
                        snapshot: pending.committed.snapshot.clone(),
                        identity: Arc::clone(&pending.committed.identity),
                        changed_rows: pending.rows.into_iter().collect(),
                    },
                )
            })
            .collect();
        mailbox.control_bytes = 0;
        mailbox.graphics_bytes = 0;
        let had_graphics = !mailbox.graphics.is_empty();
        let updates = Updates {
            materializing: mailbox.materializing.clone(),
            status: mailbox.status.clone(),
            panes,
            controls: std::mem::take(&mut mailbox.controls),
            graphics: std::mem::take(&mut mailbox.graphics),
            graphics_placements: std::mem::take(&mut mailbox.graphics_placements),
            cell_pixels: mailbox.cell_pixels,
            precise_cell_pixels: mailbox.precise_cell_pixels,
        };
        drop(mailbox);
        if had_graphics {
            let _ = self.graphics_drained.try_send(());
        }
        Ok(updates)
    }

    /// Retained snapshots become preview-only as soon as this returns no current value.
    pub fn snapshot(&self, pane: &str) -> Result<Option<Arc<Snapshot>>, Error> {
        Ok(self
            .committed(pane)?
            .and_then(|committed| committed.snapshot.clone()))
    }

    /// Returns only this session's current proof; callers must additionally hold input authority.
    pub fn committed(&self, pane: &str) -> Result<Option<Arc<CommittedPane>>, Error> {
        Ok(self
            .shared
            .lock()
            .map_err(|_| Error::Mailbox)?
            .current
            .get(pane)
            .cloned())
    }

    pub fn cancel(&self) {
        if let Ok(mut mailbox) = self.shared.lock() {
            mailbox.retire(Status::Cancelled);
        }
        self.stream.cancel();
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct WorkerExit {
    shared: Arc<Mutex<Mailbox>>,
    stream: Arc<PaneStream>,
}
impl Drop for WorkerExit {
    fn drop(&mut self) {
        self.stream.cancel();
        if let Ok(mut mailbox) = self.shared.lock() {
            mailbox.retire(Status::Failed(Arc::new(Error::WorkerStopped)));
        }
    }
}

/// A receiver is rebuilt only when the conservative graphics alarm changes.
struct Maintenance {
    deadline: Option<Instant>,
    receiver: crossbeam_channel::Receiver<Instant>,
}
impl Maintenance {
    fn new() -> Self {
        Self {
            deadline: None,
            receiver: crossbeam_channel::never(),
        }
    }
    fn arm(&mut self, deadline: Option<Instant>) {
        if self.deadline == deadline {
            return;
        }
        self.deadline = deadline;
        self.receiver = deadline.map_or_else(crossbeam_channel::never, |at| {
            crossbeam_channel::after(at.saturating_duration_since(Instant::now()))
        });
    }
}

fn run(
    mut state: TerminalState,
    mut graphics: Option<Graphics>,
    local_images: Option<tmux_graphics::LocalImages>,
    graphics_notices: (
        crossbeam_channel::Receiver<Vec<String>>,
        crossbeam_channel::Receiver<()>,
    ),
    stream: &PaneStream,
    shared: &Mutex<Mailbox>,
    mut surfaces: Option<surfaces::Owner>,
) -> Result<(), Error> {
    let (missing, drained) = graphics_notices;
    let paused_local = crossbeam_channel::never();
    let mut local = local_images.map(local::LocalTransfers::new).transpose()?;
    let local_events = local
        .as_ref()
        .map_or_else(crossbeam_channel::never, local::LocalTransfers::events);
    let mut committed = BTreeMap::new();
    let mut maintenance = Maintenance::new();
    let surface_events = surfaces
        .as_ref()
        .map_or_else(crossbeam_channel::never, surfaces::Owner::events);
    loop {
        if shared.lock().map_err(|_| Error::Mailbox)?.retired {
            state.retire();
            return Err(Error::Cancelled);
        }
        // A terminal failure invalidates queued snapshots before any more wire data is applied.
        if let Ok(error) = stream.completion().try_recv() {
            return Err(Error::Transport(error));
        }
        // Due maintenance cannot starve behind continuously ready terminal/image channels.
        let now = Instant::now();
        if let Some(surfaces) = &mut surfaces {
            surfaces.poll(now, &committed, stream)?;
        }
        if let Some(graphics) = graphics.as_mut()
            && graphics
                .next_expiry()
                .is_some_and(|deadline| deadline <= now)
        {
            let invalidated = graphics.expire(now);
            if !invalidated.is_empty() {
                publish_graphics(
                    shared,
                    stream,
                    GraphicsUpdate {
                        invalidated,
                        ..Default::default()
                    },
                )?;
                refresh_graphics(graphics, &committed, stream, shared, None)?;
            }
        }
        maintenance.arm(
            graphics
                .as_ref()
                .and_then(Graphics::next_expiry)
                .into_iter()
                .chain(surfaces.as_ref().and_then(surfaces::Owner::deadline))
                .min(),
        );
        let local_ready = if shared
            .lock()
            .map_err(|_| Error::Mailbox)?
            .local_graphics_room()
        {
            &local_events
        } else {
            &paused_local
        };
        crossbeam_channel::select! {
            recv(drained) -> _ => {}
            recv(stream.completion()) -> result => {
                return Err(result.map_or(Error::WorkerStopped, Error::Transport));
            }
            recv(stream.events()) -> result => {
                let event = result.map_err(|_| {
                    // The stream publishes completion before disconnecting events.
                    // Either select arm may win when both channels become ready.
                    stream.completion().try_recv().map_or(Error::WorkerStopped, Error::Transport)
                })?;
                if let tmux_stream::Event::GraphicsBinary(bytes) = event {
                    let graphics = graphics.as_mut().ok_or(Error::GraphicsDisabled)?;
                    let update = graphics.accept_binary(&bytes, Instant::now())?;
                    publish_graphics(shared, stream, update)?;
                    continue;
                }
                let outcome = state.apply(event)?;
                // ACK follows validated retained state, and is queued before publication.
                if let Outcome::Updated { ack, .. } = &outcome {
                    let json = serde_json::to_string(&serde_json::json!({"type":"terminal-delivery-ack","ack":ack})).map_err(Error::Ack)?;
                    stream.try_send(Command::from_json(json)?)?;
                }
                if let Outcome::Projected {receipt,..} = &outcome {
                    let json=serde_json::to_string(&serde_json::json!({"type":"terminal-projection-receipt","receipt":receipt})).map_err(Error::Ack)?;
                    stream.try_send(Command::from_json(json)?)?;
                }
                match &outcome {
                    Outcome::Ready(_) => {
                        if let Some(surfaces) = &mut surfaces { surfaces.start(stream)?; }
                    }
                    Outcome::Control(raw) => {
                        #[derive(serde::Deserialize)]
                        struct Kind<'a> { #[serde(rename="type")] kind: &'a str }
                        let kind = serde_json::from_str::<Kind<'_>>(raw.get()).map_err(Error::Ack)?.kind;
                        // Parsing a native control frame does not negotiate native
                        // storage. Until a platform owner is attached to this exact
                        // session, never expose unsolicited offers to presentation.
                        if matches!(kind, "terminal-surface-available" | "terminal-surface-peer" | "terminal-surface-offer" | "terminal-surface-fallback") {
                            surfaces.as_mut().ok_or(Error::GraphicsDisabled)?.accept(raw.get(), &committed, stream)?;
                            continue;
                        }
                        if kind == "terminal-graphics-local" {
                            local.as_mut().ok_or(Error::GraphicsDisabled)?.accept(raw.get(),graphics.as_mut().ok_or(Error::GraphicsDisabled)?,stream,shared)?;
                            continue;
                        }
                        if let Some(graphics) = graphics.as_mut() {
                            let update = graphics.accept_control(raw, Instant::now())?;
                            if update.handled {
                                let changed = update.state_changed;
                                publish_graphics(shared, stream, update)?;
                                if changed { refresh_graphics(graphics, &committed, stream, shared, None)?; }
                                continue;
                            }
                        } else {
                            let kind: serde_json::Value = serde_json::from_str(raw.get()).map_err(Error::Ack)?;
                            if matches!(kind["type"].as_str(), Some("terminal-graphics" | "terminal-graphics-blob")) { return Err(Error::GraphicsDisabled); }
                        }
                    }
                    Outcome::Updated {..} | Outcome::Projected {..} => {
                        if let Some(graphics) = graphics.as_mut() {
                            let (pane,proof)=committed_outcome(&outcome).ok_or(Error::Mailbox)?;
                            let invalidated=graphics.bind(&pane,&proof)?;
                            publish_graphics(shared,stream,GraphicsUpdate{invalidated,..Default::default()})?;
                            committed.insert(pane,proof);
                            refresh_graphics(graphics,&committed,stream,shared,Some(outcome))?;
                            continue;
                        }
                    }
                    _ => {}
                }
                publish(shared, outcome)?;
            }
            recv(local_ready) -> result => {
                local.as_mut().ok_or(Error::GraphicsDisabled)?.apply(result.map_err(|_|Error::WorkerStopped)?,graphics.as_mut().ok_or(Error::GraphicsDisabled)?,stream,shared)?;
            }
            recv(surface_events) -> _ => {
                if let Some(surfaces) = &mut surfaces { surfaces.wake(&committed, stream)?; }
            }
            recv(missing) -> result => {
                let digests = result.map_err(|_| Error::Cancelled)?;
                if let Some(graphics) = graphics.as_mut() {
                    graphics.missing(&digests);
                    publish_graphics(shared, stream, GraphicsUpdate { invalidated: digests, ..Default::default() })?;
                    refresh_graphics(graphics, &committed, stream, shared, None)?;
                }
            }
            recv(maintenance.receiver) -> _ => {
                // The top-of-loop due check owns expiry and replacement of this one-shot alarm.
            }
        }
    }
}

fn publish(shared: &Mutex<Mailbox>, outcome: Outcome) -> Result<(), Error> {
    let mut mailbox = shared.lock().map_err(|_| Error::Mailbox)?;
    publish_locked(&mut mailbox, outcome)
}

fn publish_locked(mailbox: &mut Mailbox, outcome: Outcome) -> Result<(), Error> {
    if mailbox.retired {
        return Err(Error::Cancelled);
    }
    let proof = committed_outcome(&outcome);
    match outcome {
        Outcome::Pending => {}
        Outcome::Materializing(pane) => {
            mailbox.materializing.insert(pane);
        }

        Outcome::Ready(ready) => mailbox.status = Status::Ready(Arc::new(ready)),
        Outcome::Updated {
            pane, changed_rows, ..
        }
        | Outcome::Projected {
            pane, changed_rows, ..
        } => {
            mailbox.commit(pane, proof.ok_or(Error::Mailbox)?.1, changed_rows);
        }
        Outcome::Control(control) => {
            if mailbox.controls.len() >= CONTROL_COUNT
                || control.get().len() > CONTROL_BYTES - mailbox.control_bytes
            {
                return Err(Error::ControlBacklog);
            }
            mailbox.control_bytes += control.get().len();
            mailbox.controls.push(control);
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "tmux_native_session_tests.rs"]
mod tests;

fn send_graphics_requests(
    stream: &PaneStream,
    requests: Vec<tmux_graphics::Request>,
) -> Result<(), Error> {
    for request in requests {
        let json = serde_json::to_string(&serde_json::json!({"type":"terminal-graphics-request","pane":request.pane,"digests":request.digests})).map_err(Error::Ack)?;
        stream.try_send(Command::from_json(json)?)?;
    }
    Ok(())
}
fn publish_graphics(
    shared: &Mutex<Mailbox>,
    stream: &PaneStream,
    update: GraphicsUpdate,
) -> Result<(), Error> {
    send_graphics_requests(stream, update.requests)?;
    let mut mailbox = shared.lock().map_err(|_| Error::Mailbox)?;
    if mailbox.retired {
        return Err(Error::Cancelled);
    }
    if !update.invalidated.is_empty() {
        mailbox.graphics_event(GraphicsEvent::Invalidate(update.invalidated))?;
    }
    if let Some(chunk) = update.chunk {
        mailbox.graphics_event(GraphicsEvent::Chunk(chunk))?;
    }
    Ok(())
}
fn refresh_graphics(
    graphics: &mut Graphics,
    committed: &BTreeMap<String, Arc<CommittedPane>>,
    stream: &PaneStream,
    shared: &Mutex<Mailbox>,
    outcome: Option<Outcome>,
) -> Result<(), Error> {
    let mut updates = BTreeMap::new();
    for (pane, proof) in committed {
        let placements = graphics.placements(pane, proof, Instant::now())?;
        send_graphics_requests(stream, placements.requests)?;
        updates.insert(
            pane.clone(),
            Arc::new(PaneGraphics {
                identity: Arc::clone(&proof.identity),
                placements: placements.placements,
            }),
        );
    }
    let mut mailbox = shared.lock().map_err(|_| Error::Mailbox)?;
    if mailbox.retired {
        return Err(Error::Cancelled);
    }
    if let Some(outcome) = outcome {
        if let Outcome::Updated {
            pane, changed_rows, ..
        }
        | Outcome::Projected {
            pane, changed_rows, ..
        } = outcome
        {
            // Graphics and terminal presentation must share the very same proof.
            // Rebuilding its identity from equal ACK fields defeats the renderer’s
            // pointer fence and makes every otherwise valid placement disappear.
            let proof = committed.get(&pane).ok_or(Error::Mailbox)?;
            mailbox.commit(pane, Arc::clone(proof), changed_rows);
        } else {
            publish_locked(&mut mailbox, outcome)?;
        }
    }
    mailbox.graphics_placements.extend(updates);
    mailbox.cell_pixels = graphics.takes_cell_pixels();
    mailbox.precise_cell_pixels = graphics.takes_precise_cell_pixels();
    Ok(())
}

fn committed_outcome(outcome: &Outcome) -> Option<(String, Arc<CommittedPane>)> {
    let (pane, snapshot, generation, incarnation, nonce, revision, hash) = match outcome {
        Outcome::Updated {
            pane,
            snapshot,
            ack,
            ..
        } => (
            pane,
            snapshot,
            &ack.generation,
            &ack.incarnation,
            &ack.delivery_nonce,
            ack.canonical_revision,
            &ack.canonical_state_hash,
        ),
        Outcome::Projected {
            pane,
            snapshot,
            receipt,
            ..
        } => (
            pane,
            snapshot,
            &receipt.generation,
            &receipt.incarnation,
            &receipt.delivery_nonce,
            receipt.canonical_revision,
            &receipt.canonical_state_hash,
        ),
        _ => return None,
    };
    Some((
        pane.clone(),
        Arc::new(CommittedPane {
            snapshot: snapshot.clone(),
            identity: Arc::new(CommittedIdentity {
                generation: generation.clone(),
                incarnation: incarnation.clone(),
                delivery_nonce: nonce.clone(),
                canonical_revision: revision,
                canonical_state_hash: hash.clone(),
            }),
        }),
    ))
}
