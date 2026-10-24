//! Canonical daemon semantic delivery, independent of the presentation bridge.
mod binary;
mod compact;
mod hash;
mod projection;
mod store;
mod types;
pub use binary::{decode_binary, decode_projection};
pub use compact::decode_compact;
pub use hash::{
    hash_projection, hash_projection_tombstone, hash_representation, hash_snapshot, hash_tombstone,
};
pub use projection::{ProjectionStore, ProjectionUpdate};
pub use store::{ApplyResult, Store};
pub use types::*;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid terminal delivery JSON")]
    Json(#[from] serde_json::Error),
    #[error("invalid terminal delivery: {0}")]
    Invalid(&'static str),
    #[error("terminal delivery revision gap")]
    Revision,
    #[error("terminal delivery canonical hash mismatch")]
    Hash,
}
pub type Result<T> = std::result::Result<T, Error>;
#[cfg(test)]
mod tests;
