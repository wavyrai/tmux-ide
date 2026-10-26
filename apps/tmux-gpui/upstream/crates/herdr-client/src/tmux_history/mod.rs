//! Native bounded scrollback. No HTTP credentials or terminal cell serialization crosses Node.
mod request;
mod restoration;
pub use request::AnchorRequest;
mod size;
mod viewport;
mod wire;
pub use restoration::{AnchorAction, AnchorOperation, HistoryState, Restoration, Ticket};
pub use viewport::{Scope, Scroll, Viewport};
pub use wire::{AnchorResult, Proof, decode_result};
pub const MAX_ROWS: usize = 1000;
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
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
