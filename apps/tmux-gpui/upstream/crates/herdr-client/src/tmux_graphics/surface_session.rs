//! Native graphics lifetime for exactly one authenticated local connection.
//! Platform endpoint ownership stays outside the renderer-neutral client. The
//! socket owner must close both this state and its native receiver on disconnect.
use super::{
    surface_control::{Control, FallbackReason},
    surface_handoff::Pending,
    surface_leases::Pool,
    surface_offer::{self, Accepted},
};
use crate::tmux_native_session::CommittedPane;
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native surface control failed")]
    Control(#[from] super::surface_control::Error),
    #[error("native surface offer failed")]
    Offer(#[from] surface_offer::Error),
    #[error("native surface handoff failed")]
    Handoff(#[from] super::surface_handoff::Error),
    #[error("native surface connection is not ready")]
    NotReady,
    #[error("native surface committed generation does not match connection")]
    Generation,
}

pub struct Session {
    generation: Uuid,
    control: Control,
    pending: Pending,
    pool: Pool,
}
impl Session {
    pub fn set_waker(&mut self, wake: crossbeam_channel::Sender<()>) {
        self.pool.set_waker(wake);
    }
    /// Only construct after capability negotiation and verified local authentication.
    pub fn new(generation: Uuid, pid: u32, slot: u8, receiver: [u32; 8]) -> Result<Self, Error> {
        Self::with_nonce(generation, Uuid::new_v4(), pid, slot, receiver)
    }
    pub fn with_nonce(
        generation: Uuid,
        nonce: Uuid,
        pid: u32,
        slot: u8,
        receiver: [u32; 8],
    ) -> Result<Self, Error> {
        Ok(Self {
            generation,
            control: Control::with_nonce(generation, nonce, pid, slot, receiver)?,
            pending: Pending::default(),
            pool: Pool::default(),
        })
    }
    pub fn receiver_frame(&self) -> Result<String, Error> {
        Ok(self.control.receiver_frame()?)
    }
    pub fn challenge(&self) -> [u8; 16] {
        self.control.challenge()
    }
    pub fn accept_peer(&mut self, raw: &[u8]) -> Result<bool, Error> {
        Ok(self.control.accept_peer(raw)?)
    }
    pub fn expected_peer(&self) -> Option<[u32; 8]> {
        self.control.expected_peer()
    }
    /// The platform receiver must have completed mutual kernel proof first.
    pub fn confirm_kernel_peer(&mut self, actual: [u32; 8]) -> Result<(), Error> {
        Ok(self.control.confirm_kernel_peer(actual)?)
    }
    pub fn admit(
        &mut self,
        raw: &[u8],
        pane: &str,
        committed: &CommittedPane,
        now: Instant,
    ) -> Result<(), Error> {
        if !self.control.ready() {
            return Err(Error::NotReady);
        }
        if Uuid::parse_str(&committed.identity.generation).ok() != Some(self.generation) {
            return Err(Error::Generation);
        }
        let accepted = surface_offer::accept(raw, pane, committed, &mut self.pool)?;
        Ok(self.pending.stage(accepted, now)?)
    }
    /// Consume a native right only after offers are staged: the OS queue supplies
    /// backpressure while the control channel catches up, without unbudgeted rights.
    pub fn has_pending(&self) -> bool {
        self.control.ready() && !self.pending.is_empty()
    }
    pub fn pending_pane(&self, sequence: u64, ticket: Uuid) -> Option<&str> {
        self.control.ready().then_some(())?;
        self.pending.pane(sequence, ticket)
    }
    pub fn bind<T>(
        &mut self,
        sequence: u64,
        ticket: Uuid,
        right: T,
        pane: &str,
        committed: &CommittedPane,
        now: Instant,
    ) -> Result<(Accepted, T), Error> {
        if !self.control.ready() {
            return Err(Error::NotReady);
        }
        Ok(self
            .pending
            .bind(sequence, ticket, right, pane, committed, now)?)
    }
    /// Tick on the transport worker. Returned fallback must be sent on this socket
    /// and the platform receiver closed; already imported GPU leases stay charged.
    pub fn poll(&mut self, now: Instant) -> Result<Option<String>, Error> {
        let fallback = self.control.poll_timeout(now)?;
        if fallback.is_some() {
            self.pending = Pending::default();
        }
        self.pending.expire(now);
        Ok(fallback)
    }
    pub fn fallback(&mut self, reason: FallbackReason) -> Result<String, Error> {
        let frame = self.control.fallback_frame(reason)?;
        self.pending = Pending::default();
        Ok(frame)
    }
    pub fn accept_fallback(&mut self, raw: &[u8]) -> Result<FallbackReason, Error> {
        let reason = self.control.accept_fallback(raw)?;
        self.pending = Pending::default();
        Ok(reason)
    }
    /// Drain only on the original socket. Fallback still permits final GPU ACKs;
    /// disconnect never forwards old retirements into a replacement connection.
    pub fn next_retirement(&mut self) -> Result<Option<String>, Error> {
        self.pool
            .next_retirement()
            .map(|event| self.control.retirement_frame(event).map_err(Error::from))
            .transpose()
    }
    pub fn reserved_bytes(&self) -> usize {
        self.pool.reserved_bytes()
    }
    pub fn close(&mut self) {
        self.control.close();
        self.pool.retire();
        self.pending = Pending::default();
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}
