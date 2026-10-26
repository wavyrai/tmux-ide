//! Producer offers derive canonical identity from an actual committed pane and
//! layout from retained native backing. Queueing this metadata grants no transfer.
use super::{
    surface_leases::Layout,
    surface_offer::{Offer, Placement},
};
use crate::tmux_native_session::CommittedPane;
use serde::Serialize;
use uuid::Uuid;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native producer offer identity or placement is invalid")]
    Identity,
    #[error("native producer backing is invalid")]
    Layout(#[from] super::surface_leases::Error),
    #[error("native producer offer cannot be encoded")]
    Json(#[from] serde_json::Error),
    #[error("native producer offer exceeds control bound")]
    Bounds,
}
pub struct Frame {
    pub sequence: u64,
    pub surface_id: Uuid,
    pub storage_ticket: Uuid,
    pub layout: Layout,
    pub placement: Placement,
}
pub struct Submission {
    pub(crate) connection: Uuid,
    pub(crate) generation: String,
    pub(crate) pane: String,
    pub(crate) sequence: u64,
    pub(crate) allocation_bytes: usize,
    pub(crate) encoded: String,
}
impl Submission {
    pub fn new(
        connection: Uuid,
        pane: &str,
        committed: &CommittedPane,
        frame: Frame,
    ) -> Result<Self, Error> {
        let identity = &committed.identity;
        if Uuid::parse_str(&identity.generation).map_or(true, |v| v.is_nil())
            || Uuid::parse_str(&identity.delivery_nonce).map_or(true, |v| v.is_nil())
            || identity.incarnation.is_empty()
            || identity.incarnation.encode_utf16().count() > 256
            || identity.canonical_revision > 9_007_199_254_740_991
            || identity.canonical_state_hash.len() != 16
            || !identity
                .canonical_state_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Identity);
        }
        let snapshot = committed.snapshot.as_ref().ok_or(Error::Identity)?;
        let p = frame.placement;
        if connection.is_nil()
            || !crate::tmux_stream::valid_pane(pane)
            || frame.sequence == 0
            || frame.sequence > 9_007_199_254_740_991
            || frame.surface_id.is_nil()
            || frame.storage_ticket.is_nil()
            || p.rows == 0
            || p.columns == 0
            || p.row
                .checked_add(p.rows)
                .is_none_or(|v| v > snapshot.rows.min(16384))
            || p.column
                .checked_add(p.columns)
                .is_none_or(|v| v > snapshot.cols.min(16384))
        {
            return Err(Error::Identity);
        }
        let bytes = frame.layout.bytes()?;
        let offer = Offer {
            kind: "terminal-surface-offer".into(),
            version: 1,
            pane: pane.into(),
            generation: identity.generation.clone(),
            incarnation: identity.incarnation.clone(),
            delivery_nonce: identity.delivery_nonce.clone(),
            canonical_revision: identity.canonical_revision,
            canonical_state_hash: identity.canonical_state_hash.clone(),
            sequence: frame.sequence,
            surface_id: frame.surface_id,
            placement: p,
            storage_ticket: frame.storage_ticket,
            format: "bgra8-straight".into(),
            width: frame.layout.width,
            height: frame.layout.height,
            stride: frame.layout.stride,
            allocation_bytes: bytes,
        };
        #[derive(Serialize)]
        struct Envelope<'a> {
            #[serde(rename = "type")]
            kind: &'static str,
            connection: Uuid,
            offer: &'a Offer,
        }
        let encoded = serde_json::to_string(&Envelope {
            kind: "offer",
            connection,
            offer: &offer,
        })?;
        if encoded.len() > super::surface_control::MAX_CONTROL_BYTES {
            return Err(Error::Bounds);
        }
        Ok(Self {
            connection,
            generation: identity.generation.clone(),
            pane: pane.into(),
            sequence: frame.sequence,
            allocation_bytes: bytes,
            encoded,
        })
    }
}

#[cfg(test)]
#[path = "surface_provider_offer_tests.rs"]
mod tests;
