//! Complete-canvas application producer. Operate and poll on one render worker.
use crate::{Producer, canvas};
use herdr_client::{
    tmux_daemon::{LocalDaemon, TerminalSelection},
    tmux_graphics::surface_offer::Placement,
    tmux_handoff::ServerScope,
    tmux_native_session::{self, CommittedIdentity, NativeSession, Status},
};
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVPixelBuffer;
use std::{collections::BTreeMap, sync::Arc, time::Instant};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native canvas source discovery failed")]
    Discovery(#[from] herdr_client::tmux_daemon::Error),
    #[error("native canvas source failed")]
    Source(#[from] tmux_native_session::Error),
    #[error("native canvas source stopped")]
    SourceStopped(#[source] Arc<tmux_native_session::Error>),
    #[error("native canvas producer failed")]
    Producer(#[from] crate::Error),
    #[error("native canvas conversion failed")]
    Canvas(#[from] canvas::Error),
    #[error("native canvas publisher is closed")]
    Closed,
    #[error("native canvas sequence exhausted")]
    Sequence,
    #[error("native canvas placement is invalid")]
    Placement,
}

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    frame: u64,
    incarnation: String,
    nonce: String,
    revision: u64,
    hash: String,
    rejected: u64,
}
impl Stamp {
    fn new(frame: u64, identity: &CommittedIdentity, rejected: u64) -> Self {
        Self {
            frame,
            incarnation: identity.incarnation.clone(),
            nonce: identity.delivery_nonce.clone(),
            revision: identity.canonical_revision,
            hash: identity.canonical_state_hash.clone(),
            rejected,
        }
    }
}
struct Canvas {
    sequence: u64,
    buffer: CFRetained<CVPixelBuffer>,
    rows: usize,
    columns: usize,
}

pub struct RgbaCanvas<'a> {
    pub width: usize,
    pub height: usize,
    pub rows: usize,
    pub columns: usize,
    pub rgba: &'a [u8],
    pub premultiplied: bool,
}

/// Two submitted frames per receiver permit replacement of the currently painted
/// frame. One latest canvas is retained outside those bounded retirement leases;
/// newer canvases supersede it rather than accumulating in a FIFO.
pub struct Publisher {
    source: NativeSession,
    producer: Producer,
    pane: String,
    surface: Uuid,
    sequence: u64,
    latest: Option<Canvas>,
    submitted: BTreeMap<Uuid, Stamp>,
    closed: bool,
}
impl Publisher {
    /// Connect only to a selected, verified local daemon. Selection must be
    /// read-only and contain exactly the application's pane.
    pub fn connect(
        owner: &Arc<LocalDaemon>,
        scope: &ServerScope,
        selection: &TerminalSelection,
    ) -> Result<Self, Error> {
        let client = owner.select_server(scope)?;
        let handoff = client.issue_surface_source(selection)?;
        let (options, workspace, _) = handoff.into_connection();
        let source = NativeSession::spawn_cell_observer(options, workspace)?;
        let mut producer = Producer::connect(owner)?;
        producer.watch_demand(std::slice::from_ref(&selection.selected_pane))?;
        Ok(Self {
            source,
            producer,
            pane: selection.selected_pane.clone(),
            surface: Uuid::new_v4(),
            sequence: 0,
            latest: None,
            submitted: BTreeMap::new(),
            closed: false,
        })
    }
    /// Unknown demand preserves ordinary terminal output.
    pub fn kitty_required(&self) -> bool {
        self.closed || self.producer.kitty_required(&self.pane)
    }
    /// Ready authenticated viewers for this pane. Zero requires Kitty output.
    pub fn receivers(&self) -> usize {
        if self.closed {
            return 0;
        }
        self.producer
            .receivers()
            .filter(|(_, panes)| panes.contains(&self.pane))
            .count()
    }
    /// Submitted backing still held for receiver/GPU retirement, across peers.
    pub fn retained_frames(&self) -> usize {
        self.producer
            .peers
            .values()
            .map(|peer| peer.frames.outstanding())
            .sum()
    }
    /// Call on changed complete canvases, then keep polling even while idle so
    /// GPU retirement can release capacity and the latest frame can be sent.
    pub fn present_rgba(&mut self, frame: RgbaCanvas<'_>) -> Result<(), Error> {
        let RgbaCanvas {
            width,
            height,
            rows,
            columns,
            rgba,
            premultiplied,
        } = frame;
        if self.closed {
            return Err(Error::Closed);
        }
        let result = (|| {
            if rows == 0 || columns == 0 || rows > 16384 || columns > 16384 {
                return Err(Error::Placement);
            }
            let sequence = self.sequence.checked_add(1).ok_or(Error::Sequence)?;
            let buffer = canvas::copy_rgba(width, height, rgba, premultiplied)?;
            self.latest = Some(Canvas {
                sequence,
                buffer,
                rows,
                columns,
            });
            self.sequence = sequence;
            self.poll_inner()
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    pub fn poll(&mut self) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        let result = self.poll_inner();
        if result.is_err() {
            self.close();
        }
        result
    }
    fn poll_inner(&mut self) -> Result<(), Error> {
        // The producer needs its own canonical identity, not a GUI projection
        // requiring content subscriptions to every neighbouring pane.
        match self.source.drain()?.status {
            Status::Failed(error) => return Err(Error::SourceStopped(error)),
            Status::Cancelled => return Err(Error::Closed),
            Status::Connecting | Status::Ready(_) => {}
        }
        self.producer.poll(Instant::now())?;
        let receivers: Vec<_> = self
            .producer
            .receivers()
            .filter(|(_, panes)| panes.contains(&self.pane))
            .map(|(id, _)| id)
            .collect();
        self.submitted.retain(|id, _| receivers.contains(id));
        let Some(canvas) = &self.latest else {
            return Ok(());
        };
        let Some(current) = self.source.committed(&self.pane)? else {
            return Ok(());
        };
        let Some(snapshot) = &current.snapshot else {
            return Ok(());
        };
        // A resize can precede its canonical grid update. Wait for that exact
        // geometry rather than stretching old browser pixels over another grid.
        if snapshot.rows != canvas.rows || snapshot.cols != canvas.columns {
            return Ok(());
        }
        for connection in receivers {
            let stamp = Stamp::new(
                canvas.sequence,
                &current.identity,
                self.producer.rejections(connection).unwrap_or(0),
            );
            // Retirement can discard an admitted frame during a viewport change
            // without changing this source's canonical stamp. With no backing
            // left at the receiver, resend the latest canvas even if unchanged.
            if !needs_submission(
                self.submitted.get(&connection) == Some(&stamp),
                self.producer.outstanding(connection),
            ) {
                continue;
            }
            self.producer.submit(
                connection,
                &self.pane,
                &current,
                self.surface,
                Placement {
                    row: 0,
                    column: 0,
                    rows: canvas.rows,
                    columns: canvas.columns,
                },
                canvas.buffer.clone(),
            )?;
            self.submitted.insert(connection, stamp);
        }
        Ok(())
    }
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.source.cancel();
        self.producer.close();
        self.latest = None;
        self.submitted.clear();
    }
}
impl Drop for Publisher {
    fn drop(&mut self) {
        self.close();
    }
}

fn needs_submission(same_stamp: bool, outstanding: Option<usize>) -> bool {
    match outstanding {
        Some(0) => true,
        Some(1) => !same_stamp,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
