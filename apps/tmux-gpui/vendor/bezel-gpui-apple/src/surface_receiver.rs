//! Connection-owned native receiver. Run its nonblocking polls on the transport
//! worker after authenticated control has established the expected kernel peer.
use crate::{
    surface_inbox::{Delivery, Inbox, SendRight, SendStatus, SenderIdentity},
    surface_rendezvous::Registration,
};
use anyhow::{Context as _, Result, ensure};
use std::time::Instant;

struct Proof {
    registration: Registration,
    reply: Option<SendRight>,
    pixel_endpoint: SendRight,
    deadline: Instant,
}
/// Owns every receive right for one connection. Dropping or closing it revokes
/// both proof and pixel endpoints; already imported GPU storage owns its leases
/// independently. Never reuse this object for a replacement connection.
pub struct Receiver {
    peer: SenderIdentity,
    challenge: [u8; 16],
    proof: Option<Proof>,
    pixels: Option<Inbox>,
}
impl Receiver {
    /// `peer` and `challenge` must come from this connection's authenticated
    /// control state, not an unauthenticated lookup or received message body.
    /// The deadline is the original handshake deadline, not time since peer arrival.
    pub fn new(
        registration: Registration,
        peer: SenderIdentity,
        challenge: [u8; 16],
        deadline: Instant,
    ) -> Result<Self> {
        ensure!(challenge != [0; 16], "missing native receiver challenge");
        let (pixels, pixel_endpoint) = Inbox::new()?;
        Ok(Self {
            peer,
            challenge,
            proof: Some(Proof {
                registration,
                reply: None,
                pixel_endpoint,
                deadline,
            }),
            pixels: Some(pixels),
        })
    }
    /// True only after kernel peer proof and successful reciprocal endpoint send.
    /// A full peer queue preserves one pending reply, never spins or allocates more.
    /// Any error permanently closes this receiver so the caller can fall back.
    pub fn poll(&mut self, now: Instant) -> Result<bool> {
        match self.poll_inner(now) {
            Ok(ready) => Ok(ready),
            Err(error) => {
                self.close();
                Err(error)
            }
        }
    }
    fn poll_inner(&mut self, now: Instant) -> Result<bool> {
        ensure!(self.pixels.is_some(), "native receiver is closed");
        let Some(proof) = &mut self.proof else {
            return Ok(true);
        };
        ensure!(now < proof.deadline, "native receiver proof timed out");
        if proof.reply.is_none() {
            proof.reply = proof
                .registration
                .inbox()
                .context("native receiver proof endpoint missing")?
                .try_receive_endpoint(self.peer, self.challenge)?;
        }
        let Some(reply) = &proof.reply else {
            return Ok(false);
        };
        match reply.try_send_endpoint(&proof.pixel_endpoint, self.challenge)? {
            SendStatus::Queued => {
                // Revoke the rendezvous immediately; only the proven peer has
                // the pixel endpoint and cannot replay the proof on this slot.
                self.proof = None;
                Ok(true)
            }
            SendStatus::Backpressured | SendStatus::Interrupted => Ok(false),
        }
    }
    pub fn ready(&self) -> bool {
        self.pixels.is_some() && self.proof.is_none()
    }
    /// The caller must still correlate ticket/sequence with an admitted offer,
    /// reserve storage, and validate pane identity before import and presentation.
    pub fn try_receive(&mut self) -> Result<Option<Delivery>> {
        ensure!(self.ready(), "native receiver proof is incomplete");
        let result = self
            .pixels
            .as_mut()
            .context("native receiver is closed")?
            .try_receive_from(self.peer);
        if result.is_err() {
            self.close();
        }
        result
    }
    pub fn close(&mut self) {
        self.proof = None;
        self.pixels = None;
    }
}
#[cfg(test)]
#[path = "surface_receiver_tests.rs"]
mod tests;
