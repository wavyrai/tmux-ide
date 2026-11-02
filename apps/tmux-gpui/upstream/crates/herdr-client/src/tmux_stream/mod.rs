//! One issued pane-stream connection. Policy, leases and replica application belong to callers.
mod boundary;
mod wire;
mod worker;

pub use wire::{ConnectOptions, Event, IssuedDescriptor, Ready, ViewerMode};
pub(crate) use wire::{valid_identity, valid_pane};
pub use worker::{Command, PaneStream};

pub const SUBPROTOCOL: &str = "tmux-ide-pane-stream.v2";
pub const MAX_CLIENT_BYTES: usize = 4096;
pub const MAX_SERVER_BYTES: usize = 1024 * 1024;

#[derive(thiserror::Error)]
pub enum Error {
    #[error("remote pane-stream identity verification failed")]
    RemoteIdentity(#[source] crate::tmux_ssh::IdentityError),
    #[error("invalid pane-stream descriptor")]
    Descriptor,
    #[error("invalid pane-stream connection headers")]
    Headers,
    #[error("pane-stream capability expired")]
    Expired,
    #[error("pane-stream I/O failed")]
    Io(#[from] std::io::Error),
    // HTTP errors can contain a reflected ticket or terminal content. Never format the source.
    #[error("pane-stream websocket failed")]
    WebSocket(#[source] Box<tungstenite::Error>),
    #[error("invalid pane-stream JSON")]
    Json(#[source] serde_json::Error),
    #[error("pane-stream peer identity mismatch")]
    Identity,
    /// The peer is a daemon released before interactive input lifetime (2.9.11).
    #[error("pane-stream daemon is too old for interactive input")]
    DaemonTooOld,
    #[error("unexpected pane-stream frame")]
    Frame,
    #[error("pane-stream frame exceeds the bound")]
    FrameBound,
    #[error("pane-stream event backlog exceeded the bound")]
    EventBacklog,
    #[error("pane-stream command queue is full")]
    CommandBacklog,
    #[error("pane-stream disconnected")]
    Disconnected,
    /// The peer closed the socket and said why. Diagnostics only; same policy as `Disconnected`.
    #[error("pane-stream closed by the peer")]
    Closed(Close),
    #[error("pane-stream cancelled")]
    Cancelled,
    #[error("pane-stream readiness timed out")]
    ReadyTimeout,
}

/// A peer close frame, bounded for logs: the code, and the reason only when it is a
/// short token (the daemon's are like `output-backpressure`). Anything else is dropped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Close {
    pub code: u16,
    pub reason: Option<String>,
}
impl Close {
    pub(crate) fn new(code: u16, reason: &str) -> Self {
        let token = !reason.is_empty()
            && reason.len() <= 64
            && reason
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b));
        Self {
            code,
            reason: token.then(|| reason.to_owned()),
        }
    }
}

impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Sources remain typed for explicit inspection, never implicit diagnostic logging.
        std::fmt::Display::fmt(self, f)
    }
}

impl From<tungstenite::Error> for Error {
    fn from(error: tungstenite::Error) -> Self {
        Self::WebSocket(Box::new(error))
    }
}

#[cfg(test)]
mod tests;
