//! Producer-side native endpoint handshake. Bootstrap lookup can send only a
//! proof endpoint; pixels remain unavailable until reciprocal kernel proof.
use crate::{
    surface_inbox::{Inbox, SendRight, SendStatus, SenderIdentity},
    surface_port::SurfacePort,
    surface_rendezvous::{UnverifiedEndpoint, lookup_unverified},
};
use anyhow::{Context as _, Result, ensure};
use std::time::Instant;

struct Proof {
    pid: u32,
    slot: u8,
    endpoint: Option<UnverifiedEndpoint>,
    reply: Inbox,
    reply_endpoint: SendRight,
    sent: bool,
    deadline: Instant,
}
/// One authenticated control connection's producer transport. Run polls on the
/// provider worker, never the UI thread. Closing drops every owned send/receive
/// right. It does not authorize overwriting outstanding GPU storage: the provider
/// must retain immutable backing until its corresponding control retirement.
pub struct Sender {
    peer: SenderIdentity,
    challenge: [u8; 16],
    proof: Option<Proof>,
    pixels: Option<SendRight>,
    last_sequence: u64,
}
impl Sender {
    /// All endpoint coordinates and the full expected peer identity must come
    /// from authenticated same-host control, never from terminal content.
    pub fn new(
        pid: u32,
        slot: u8,
        peer: SenderIdentity,
        challenge: [u8; 16],
        deadline: Instant,
    ) -> Result<Self> {
        ensure!(
            pid > 0 && pid <= i32::MAX as u32 && slot < 32 && challenge != [0; 16],
            "invalid native sender endpoint"
        );
        let (reply, reply_endpoint) = Inbox::new()?;
        Ok(Self {
            peer,
            challenge,
            proof: Some(Proof {
                pid,
                slot,
                endpoint: None,
                reply,
                reply_endpoint,
                sent: false,
                deadline,
            }),
            pixels: None,
            last_sequence: 0,
        })
    }
    /// A missing service or full kernel queue stays pending until the original
    /// deadline. No retry allocates another reply inbox or extends that deadline.
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
        if self.pixels.is_some() {
            return Ok(true);
        }
        let proof = self.proof.as_mut().context("native sender is closed")?;
        ensure!(now < proof.deadline, "native sender proof timed out");
        if !proof.sent {
            if proof.endpoint.is_none() {
                proof.endpoint = lookup_unverified(proof.pid, proof.slot)?;
            }
            let Some(endpoint) = &proof.endpoint else {
                return Ok(false);
            };
            match endpoint.try_send_proof(&proof.reply_endpoint, self.challenge)? {
                SendStatus::Queued => {
                    proof.sent = true;
                    proof.endpoint = None;
                }
                SendStatus::Backpressured | SendStatus::Interrupted => return Ok(false),
            }
        }
        if let Some(pixels) = proof
            .reply
            .try_receive_endpoint(self.peer, self.challenge)?
        {
            self.pixels = Some(pixels);
            self.proof = None;
            return Ok(true);
        }
        Ok(false)
    }
    pub fn ready(&self) -> bool {
        self.pixels.is_some()
    }
    /// The authenticated offer must precede this send. Queued means transferred,
    /// not painted or retired; never mutate backing based on this return value.
    pub fn try_send(
        &mut self,
        surface: &SurfacePort,
        ticket: [u8; 16],
        sequence: u64,
    ) -> Result<SendStatus> {
        ensure!(
            sequence > self.last_sequence && sequence <= 9_007_199_254_740_991 && ticket != [0; 16],
            "invalid native sender delivery identity"
        );
        let result = self
            .pixels
            .as_ref()
            .context("native sender proof is incomplete")?
            .try_send(surface, ticket, sequence);
        match result {
            Ok(SendStatus::Queued) => {
                self.last_sequence = sequence;
                Ok(SendStatus::Queued)
            }
            Ok(status) => Ok(status),
            Err(error) => {
                self.close();
                Err(error)
            }
        }
    }
    pub fn close(&mut self) {
        self.proof = None;
        self.pixels = None;
    }
}
#[cfg(test)]
#[path = "surface_sender_tests.rs"]
mod tests;
