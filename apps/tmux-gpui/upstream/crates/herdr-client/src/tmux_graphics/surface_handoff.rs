//! Join an admitted control offer with its separately received native capability.
//! The native receiver authenticates its endpoint before calling bind; the generic
//! right must own its OS capability and release it on Drop (e.g. SurfacePort).
use super::{surface_leases::MAX_OUTSTANDING_SURFACES, surface_offer::Accepted};
use crate::tmux_native_session::CommittedPane;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

const HANDOFF_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("native surface handoff queue is full")]
    Full,
    #[error("native surface handoff sequence is stale")]
    Sequence,
    #[error("native surface handoff ticket mismatch")]
    Ticket,
    #[error("native surface handoff expired")]
    Expired,
    #[error("native surface handoff pane was replaced")]
    Identity,
}
struct Waiting {
    offer: Accepted,
    since: Instant,
}
#[derive(Default)]
pub struct Pending {
    waiting: BTreeMap<u64, Waiting>,
    last_sequence: u64,
}
impl Pending {
    /// Resolve only a matching admitted ticket, never a pane named by the native
    /// message. bind still consumes and revalidates identity and deadline.
    pub fn pane(&self, sequence: u64, ticket: uuid::Uuid) -> Option<&str> {
        let waiting = self.waiting.get(&sequence)?;
        (waiting.offer.storage_ticket() == ticket).then(|| waiting.offer.pane())
    }
    pub fn is_empty(&self) -> bool {
        self.waiting.is_empty()
    }
    /// Must share the admitted offer's connection lifetime, never reused on a
    /// replacement socket. An error drops the rejected reservation immediately.
    pub fn stage(&mut self, offer: Accepted, now: Instant) -> Result<(), Error> {
        if offer.sequence() <= self.last_sequence {
            return Err(Error::Sequence);
        }
        if self.waiting.len() >= MAX_OUTSTANDING_SURFACES {
            return Err(Error::Full);
        }
        self.last_sequence = offer.sequence();
        self.waiting
            .insert(offer.sequence(), Waiting { offer, since: now });
        Ok(())
    }
    /// Consume exactly one OS right and one admitted offer. Unknown/replayed or
    /// wrong-ticket rights drop on return. A wrong ticket does not steal a valid
    /// outstanding offer; an expired/replaced offer releases its reservation.
    pub fn bind<T>(
        &mut self,
        sequence: u64,
        ticket: uuid::Uuid,
        right: T,
        pane: &str,
        committed: &CommittedPane,
        now: Instant,
    ) -> Result<(Accepted, T), Error> {
        let waiting = self.waiting.get(&sequence).ok_or(Error::Sequence)?;
        if waiting.offer.storage_ticket() != ticket {
            return Err(Error::Ticket);
        }
        // Take before validation: any failure below permanently consumes this
        // matching handoff, rather than leaving a stale capability retryable.
        let waiting = self.waiting.remove(&sequence).ok_or(Error::Sequence)?;
        if now.saturating_duration_since(waiting.since) >= HANDOFF_TIMEOUT {
            return Err(Error::Expired);
        }
        if !waiting.offer.is_current(pane, committed) {
            return Err(Error::Identity);
        }
        Ok((waiting.offer, right))
    }
    /// Called on the existing transport worker's tick, never a UI/GPU thread.
    pub fn expire(&mut self, now: Instant) {
        self.waiting
            .retain(|_, waiting| now.saturating_duration_since(waiting.since) < HANDOFF_TIMEOUT);
    }
}
