//! One negotiated same-host connection's native control state. Schema admission
//! does not replace broker authentication/locality or the mutual kernel proof.
use super::surface_leases::Retirement;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use uuid::Uuid;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) const MAX_CONTROL_BYTES: usize = 16 * 1024;
#[derive(thiserror::Error)]
pub enum Error {
    #[error("invalid native surface control metadata")]
    Schema(#[source] serde_json::Error),
    #[error("native surface control bounds exceeded")]
    Bounds,
    #[error("native surface control identity mismatch")]
    Identity,
    #[error("native surface control state does not permit this operation")]
    State,
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FallbackReason {
    Unsupported,
    Timeout,
    Identity,
    Budget,
    Storage,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Peer {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    generation: Uuid,
    connection_nonce: Uuid,
    audit_token: [u32; 8],
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Fallback {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    generation: Uuid,
    connection_nonce: Uuid,
    reason: FallbackReason,
}
#[derive(PartialEq, Eq)]
enum State {
    Awaiting,
    Peer([u32; 8]),
    Ready([u32; 8]),
    Fallback,
    Closed,
}
/// Construct only after capability negotiation on a verified local connection.
/// Every replacement connection gets new nonce/challenge and fresh state.
pub struct Control {
    generation: Uuid,
    nonce: Uuid,
    challenge: Uuid,
    pid: u32,
    slot: u8,
    receiver: [u32; 8],
    state: State,
    started: Instant,
}
impl Control {
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
        if generation.is_nil()
            || nonce.is_nil()
            || pid == 0
            || pid > i32::MAX as u32
            || slot >= 32
            || receiver == [0; 8]
        {
            return Err(Error::Bounds);
        }
        Ok(Self {
            generation,
            nonce,
            challenge: Uuid::new_v4(),
            pid,
            slot,
            receiver,
            state: State::Awaiting,
            started: Instant::now(),
        })
    }
    pub fn receiver_frame(&self) -> Result<String, Error> {
        if self.state != State::Awaiting {
            return Err(Error::State);
        }
        serde_json::to_string(
            &serde_json::json!({"type":"terminal-surface-receiver", "version":1,
            "generation":self.generation,"connectionNonce":self.nonce,"challenge":self.challenge,
            "pid":self.pid,"slot":self.slot,"auditToken":self.receiver}),
        )
        .map_err(Error::Schema)
    }
    /// Poll from the socket worker; never block the UI while awaiting proof.
    /// Duplicate peer frames cannot extend this connection's original deadline.
    pub fn poll_timeout(&mut self, now: Instant) -> Result<Option<String>, Error> {
        if matches!(self.state, State::Awaiting | State::Peer(_))
            && now.saturating_duration_since(self.started) >= HANDSHAKE_TIMEOUT
        {
            return self.fallback_frame(FallbackReason::Timeout).map(Some);
        }
        Ok(None)
    }
    pub fn challenge(&self) -> [u8; 16] {
        *self.challenge.as_bytes()
    }
    /// A repeated identical peer is idempotent; it never resets the proof state.
    pub fn accept_peer(&mut self, raw: &[u8]) -> Result<bool, Error> {
        if matches!(self.state, State::Fallback | State::Closed) {
            return Err(Error::State);
        }
        let peer: Peer = decode(raw)?;
        if peer.kind != "terminal-surface-peer"
            || peer.version != 1
            || peer.generation != self.generation
            || peer.connection_nonce != self.nonce
            || peer.audit_token == [0; 8]
        {
            return Err(Error::Identity);
        }
        match self.state {
            State::Awaiting => {
                self.state = State::Peer(peer.audit_token);
                Ok(true)
            }
            State::Peer(token) | State::Ready(token) if token == peer.audit_token => Ok(false),
            _ => Err(Error::Identity),
        }
    }
    pub fn expected_peer(&self) -> Option<[u32; 8]> {
        match self.state {
            State::Peer(peer) | State::Ready(peer) => Some(peer),
            _ => None,
        }
    }
    /// Call only with the audit identity obtained by the native proof receive.
    /// A control-frame token alone must never make native pixels ready.
    pub fn confirm_kernel_peer(&mut self, actual: [u32; 8]) -> Result<(), Error> {
        match self.state {
            State::Peer(expected) if expected == actual => {
                self.state = State::Ready(expected);
                Ok(())
            }
            _ => Err(Error::Identity),
        }
    }
    pub fn ready(&self) -> bool {
        matches!(self.state, State::Ready(_))
    }
    pub fn accept_fallback(&mut self, raw: &[u8]) -> Result<FallbackReason, Error> {
        if self.state == State::Closed {
            return Err(Error::State);
        }
        let frame: Fallback = decode(raw)?;
        if frame.kind != "terminal-surface-fallback"
            || frame.version != 1
            || frame.generation != self.generation
            || frame.connection_nonce != self.nonce
        {
            return Err(Error::Identity);
        }
        self.state = State::Fallback;
        Ok(frame.reason)
    }
    pub fn fallback_frame(&mut self, reason: FallbackReason) -> Result<String, Error> {
        if self.state == State::Closed {
            return Err(Error::State);
        }
        self.state = State::Fallback;
        serde_json::to_string(&Fallback {
            kind: "terminal-surface-fallback".into(),
            version: 1,
            generation: self.generation,
            connection_nonce: self.nonce,
            reason,
        })
        .map_err(Error::Schema)
    }
    /// Fallback does not free retained GPU storage. Retirement may still be sent
    /// on this original connection; closing it suppresses every later retirement.
    pub fn retirement_frame(&self, retirement: Retirement) -> Result<String, Error> {
        if self.state == State::Closed {
            return Err(Error::State);
        }
        if retirement.sequence == 0 || retirement.sequence > 9_007_199_254_740_991 {
            return Err(Error::Bounds);
        }
        serde_json::to_string(
            &serde_json::json!({"type":"terminal-surface-retired", "version":1,
            "generation":self.generation,"connectionNonce":self.nonce,
            "sequence":retirement.sequence}),
        )
        .map_err(Error::Schema)
    }
    pub fn close(&mut self) {
        self.state = State::Closed;
    }
}
fn decode<T: serde::de::DeserializeOwned>(raw: &[u8]) -> Result<T, Error> {
    if raw.len() > MAX_CONTROL_BYTES {
        return Err(Error::Bounds);
    }
    serde_json::from_slice(raw).map_err(Error::Schema)
}
#[cfg(test)]
#[path = "surface_control_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "surface_retirement_tests.rs"]
mod retirement_tests;
