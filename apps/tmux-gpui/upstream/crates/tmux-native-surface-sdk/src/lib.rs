//! Worker-owned local native producer. Pixel storage never enters the daemon's
//! JSON channel; only a validated offer and original-socket retirement do.
#![cfg(target_os = "macos")]

pub mod canvas;
pub mod publisher;

use gpui_apple::{
    surface_frames::Frames,
    surface_inbox::{SendStatus, SenderIdentity},
    surface_sender::Sender,
};
use herdr_client::{
    tmux_daemon::{LocalDaemon, SurfaceProvider, SurfaceProviderError},
    tmux_graphics::{
        surface_leases::Layout,
        surface_offer::Placement,
        surface_provider::Event,
        surface_provider_offer::{Frame, Submission},
    },
    tmux_native_session::CommittedPane,
};
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVPixelBuffer;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native producer transport failed")]
    Transport(#[from] SurfaceProviderError),
    #[error("native producer platform operation failed")]
    Platform(#[source] anyhow::Error),
    #[error("native producer offer failed")]
    Offer(#[from] herdr_client::tmux_graphics::surface_provider_offer::Error),
    #[error("native receiver is not ready for this submission")]
    NotReady,
}
struct Peer {
    panes: Vec<String>,
    sender: Sender,
    frames: Frames,
    pending: BTreeMap<u64, bool>,
    sent: BTreeSet<u64>,
    sequence: u64,
    stopped: bool,
    rejected: u64,
}
/// Construct and operate on the same dedicated worker. This owner deliberately
/// does not implement Send: CoreVideo backing is immutable while retained here.
/// Caller must relinquish every mutable alias before submitting a buffer.
pub struct Producer {
    transport: SurfaceProvider,
    peers: BTreeMap<Uuid, Peer>,
}
impl Producer {
    pub fn watch_demand(&mut self, panes: &[String]) -> Result<(), Error> {
        self.transport.watch_demand(panes)?;
        Ok(())
    }
    pub fn kitty_required(&self, pane: &str) -> bool {
        self.transport.kitty_required(pane)
    }

    pub fn connect(owner: &Arc<LocalDaemon>) -> Result<Self, Error> {
        let identity = SenderIdentity::current().map_err(Error::Platform)?;
        Ok(Self {
            transport: owner.connect_surface_provider(identity.token())?,
            peers: BTreeMap::new(),
        })
    }
    /// Ready receivers and authorized pane names; no credential or raw endpoint
    /// escapes the transport. The renderer chooses which changed frames to submit.
    pub fn receivers(&self) -> impl Iterator<Item = (Uuid, &[String])> {
        self.peers
            .iter()
            .filter(|(_, p)| !p.stopped && p.sender.ready())
            .map(|(id, p)| (*id, p.panes.as_slice()))
    }
    /// Includes accepted frames still retained by the receiver's GPU. Use this
    /// to coalesce new application frames instead of growing a producer queue.
    pub fn outstanding(&self, connection: Uuid) -> Option<usize> {
        self.peers
            .get(&connection)
            .map(|peer| peer.frames.outstanding())
    }
    /// Changes only when the daemon refuses an offer, allowing a latest-frame
    /// publisher to retry against fresh canonical pane state without re-copying.
    pub fn rejections(&self, connection: Uuid) -> Option<u64> {
        self.peers.get(&connection).map(|peer| peer.rejected)
    }
    pub fn poll(&mut self, now: Instant) -> Result<(), Error> {
        let result = self.poll_inner(now);
        if result.is_err() {
            self.close();
        }
        result
    }
    fn poll_inner(&mut self, now: Instant) -> Result<(), Error> {
        for _ in 0..8 {
            let Some(event) = self.transport.poll()? else {
                break;
            };
            match event {
                Event::Start {
                    connection,
                    receiver,
                    panes,
                } => {
                    let peer = SenderIdentity::from_authenticated_token(receiver.audit_token)
                        .map_err(Error::Platform)?;
                    let sender = Sender::new(
                        receiver.pid,
                        receiver.slot,
                        peer,
                        *receiver.challenge.as_bytes(),
                        now + Duration::from_secs(5),
                    )
                    .map_err(Error::Platform)?;
                    self.peers.insert(
                        connection,
                        Peer {
                            panes,
                            sender,
                            frames: Frames::default(),
                            pending: BTreeMap::new(),
                            sent: BTreeSet::new(),
                            sequence: 0,
                            stopped: false,
                            rejected: 0,
                        },
                    );
                }
                Event::Offered {
                    connection,
                    sequence,
                    accepted,
                } => {
                    let p = self.peers.get_mut(&connection).ok_or(Error::NotReady)?;
                    p.offered(sequence, accepted)?;
                }
                Event::Retired {
                    connection,
                    sequence,
                } => {
                    let p = self.peers.get_mut(&connection).ok_or(Error::NotReady)?;
                    p.retired(sequence)?;
                }
                Event::Fallback { connection } => {
                    let p = self.peers.get_mut(&connection).ok_or(Error::NotReady)?;
                    p.fallback();
                }
                Event::Close { connection } => {
                    self.peers.remove(&connection);
                }
                Event::KittyDemand { .. } => {}
                Event::Registered { .. } => return Err(Error::NotReady),
            }
        }
        for p in self.peers.values_mut() {
            p.poll(now)?;
        }
        Ok(())
    }
    pub fn submit(
        &mut self,
        connection: Uuid,
        pane: &str,
        committed: &CommittedPane,
        surface_id: Uuid,
        placement: Placement,
        buffer: CFRetained<CVPixelBuffer>,
    ) -> Result<(), Error> {
        let p = self.peers.get_mut(&connection).ok_or(Error::NotReady)?;
        if p.stopped || !p.sender.ready() || !p.panes.iter().any(|v| v == pane) {
            return Err(Error::NotReady);
        }
        let sequence = p.sequence.checked_add(1).ok_or(Error::NotReady)?;
        let ticket = Uuid::new_v4();
        let d = p
            .frames
            .stage(buffer, *ticket.as_bytes(), sequence)
            .map_err(Error::Platform)?;
        p.sequence = sequence;
        let offer = Submission::new(
            connection,
            pane,
            committed,
            Frame {
                sequence,
                surface_id,
                storage_ticket: ticket,
                placement,
                layout: Layout {
                    width: d.width,
                    height: d.height,
                    stride: d.stride,
                    allocation_bytes: d.allocation_bytes,
                },
            },
        );
        let result = offer
            .map_err(Error::Offer)
            .and_then(|offer| self.transport.submit(offer).map_err(Error::Transport));
        if result.is_err() {
            p.frames.discard_unsent(sequence).map_err(Error::Platform)?;
        } else {
            p.pending.insert(sequence, false);
        }
        result
    }
    pub fn close(&mut self) {
        self.transport.close();
        self.peers.clear();
    }
}

impl Peer {
    fn offered(&mut self, sequence: u64, accepted: bool) -> Result<(), Error> {
        if let Some(ready) = self.pending.get_mut(&sequence) {
            if accepted && !self.stopped {
                *ready = true;
            } else {
                self.rejected = self.rejected.checked_add(1).ok_or(Error::NotReady)?;
                self.frames
                    .discard_unsent(sequence)
                    .map_err(Error::Platform)?;
                self.pending.remove(&sequence);
            }
        }
        Ok(())
    }
    fn retired(&mut self, sequence: u64) -> Result<(), Error> {
        if self.sent.remove(&sequence) || self.pending.remove(&sequence).is_some() {
            // Do not return mutable backing to a renderer here. A
            // future recycling pool must exclusively use this ACK.
            drop(self.frames.retire(sequence).map_err(Error::Platform)?);
        }
        Ok(())
    }
    fn fallback(&mut self) {
        self.stopped = true;
        self.sender.close();
        self.pending.clear();
        self.frames.fallback();
    }
    fn poll(&mut self, now: Instant) -> Result<(), Error> {
        if self.stopped || !self.sender.poll(now).map_err(Error::Platform)? {
            return Ok(());
        }
        if let Some((&sequence, &true)) = self.pending.first_key_value()
            && self
                .frames
                .try_send(&mut self.sender, sequence)
                .map_err(Error::Platform)?
                == SendStatus::Queued
        {
            self.pending.remove(&sequence);
            self.sent.insert(sequence);
        }
        Ok(())
    }
}
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
