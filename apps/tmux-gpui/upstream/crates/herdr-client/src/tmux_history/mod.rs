//! Native bounded scrollback. No HTTP credentials or terminal cell serialization crosses Node.
mod request;
mod restoration;
pub use request::AnchorRequest;
mod viewport;
mod wire;
pub use restoration::{AnchorAction, AnchorOperation, HistoryState, Restoration, Ticket};
pub use viewport::{Scope, Scroll, Viewport};
pub use wire::{AnchorResult, Proof, decode_result};
/// History rows the scrollback holds per pane, newest first.
pub const MAX_ROWS: usize = 10_000;
/// Row memory the scrollback holds per pane ([`crate::tmux_delivery::Row::heap_bytes`]):
/// 10,000 rows of dense coloured text up to about 200 columns.
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid history response JSON")]
    Json(#[from] serde_json::Error),
    #[error("invalid history response: {0}")]
    Invalid(&'static str),
}
pub type Result<T> = std::result::Result<T, Error>;
#[cfg(test)]
mod tests;
