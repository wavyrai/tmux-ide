//! Admission boundary for native pixel offers from an authenticated connection.
//! This decoder does not authenticate sockets or resolve storage tickets. A ticket
//! names a separately transferred capability, never a path or global IOSurface ID.
use super::surface_leases::{Layout, Lease, Pool};
use crate::tmux_native_session::{CommittedIdentity, CommittedPane};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_OFFER_BYTES: usize = 16 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(thiserror::Error)]
pub enum Error {
    #[error("invalid native surface offer schema")]
    Schema(#[source] serde_json::Error),
    #[error("native surface offer exceeds metadata bound")]
    Bounds,
    #[error("native surface offer does not match the committed pane")]
    Identity,
    #[error("unsupported native surface offer")]
    Unsupported,
    #[error("invalid native surface storage ticket")]
    Ticket,
    #[error("native surface reservation failed: {0}")]
    Reservation(#[from] super::surface_leases::Error),
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Unknown field names can contain peer-controlled data. Keep the source
        // available explicitly, but omit it from routine diagnostics.
        std::fmt::Display::fmt(self, f)
    }
}

/// Visible cell rectangle on the exact committed pane, never global pixels.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub row: usize,
    pub column: usize,
    pub rows: usize,
    pub columns: usize,
}
impl Placement {
    fn fits(self, rows: usize, columns: usize) -> bool {
        self.rows > 0
            && self.columns > 0
            && self
                .row
                .checked_add(self.rows)
                .is_some_and(|end| end <= rows.min(16384))
            && self
                .column
                .checked_add(self.columns)
                .is_some_and(|end| end <= columns.min(16384))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Offer {
    #[serde(rename = "type")]
    pub(super) kind: String,
    pub(super) version: u32,
    pub(super) pane: String,
    pub(super) generation: String,
    pub(super) incarnation: String,
    pub(super) delivery_nonce: String,
    pub(super) canonical_revision: u64,
    pub(super) canonical_state_hash: String,
    pub(super) sequence: u64,
    pub(super) surface_id: uuid::Uuid,
    pub(super) placement: Placement,
    pub(super) storage_ticket: uuid::Uuid,
    pub(super) format: String,
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) stride: usize,
    pub(super) allocation_bytes: usize,
}

/// A reservation, not imported pixels. Keep the lease with actual native backing
/// storage, and recheck identity after asynchronous import before presentation.
pub struct Accepted {
    pane: String,
    identity: Arc<CommittedIdentity>,
    sequence: u64,
    surface_id: uuid::Uuid,
    placement: Placement,
    storage_ticket: uuid::Uuid,
    layout: Layout,
    lease: Arc<Lease>,
}
impl Accepted {
    pub fn pane(&self) -> &str {
        &self.pane
    }
    pub fn is_current(&self, pane: &str, committed: &CommittedPane) -> bool {
        self.pane == pane
            && committed.snapshot.is_some()
            && Arc::ptr_eq(&self.identity, &committed.identity)
    }
    /// Project only onto a region retaining the exact admitted commit. Returning
    /// None hides replaced/zoomed/resized content rather than painting old pixels
    /// into a new pane geometry. Callers also suppress the selected history view.
    pub fn in_region(&self, region: &crate::tmux_topology::Region) -> Option<Placement> {
        if !self.is_current(&region.pane, &region.source)
            || !self.placement.fits(region.content_rows, region.width)
        {
            return None;
        }
        Some(Placement {
            row: region.content_top.checked_add(self.placement.row)?,
            column: region.left.checked_add(self.placement.column)?,
            rows: self.placement.rows,
            columns: self.placement.columns,
        })
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn placement(&self) -> Placement {
        self.placement
    }
    pub fn surface_id(&self) -> uuid::Uuid {
        self.surface_id
    }
    pub fn storage_ticket(&self) -> uuid::Uuid {
        self.storage_ticket
    }
    pub fn layout(&self) -> Layout {
        self.layout
    }
    pub fn storage_lease(&self) -> Arc<Lease> {
        Arc::clone(&self.lease)
    }
}

/// Call only after capability negotiation on the authenticated pane connection.
/// All metadata and scope checks precede reservation, ticket resolution and import.
pub fn accept(
    raw: &[u8],
    pane: &str,
    committed: &CommittedPane,
    pool: &mut Pool,
) -> Result<Accepted, Error> {
    if raw.len() > MAX_OFFER_BYTES {
        return Err(Error::Bounds);
    }
    let offer: Offer = serde_json::from_slice(raw).map_err(Error::Schema)?;
    if offer.kind != "terminal-surface-offer"
        || offer.version != 1
        || offer.format != "bgra8-straight"
    {
        return Err(Error::Unsupported);
    }
    let identity = &committed.identity;
    if committed.snapshot.is_none()
        || offer.pane != pane
        || offer.generation != identity.generation
        || offer.incarnation != identity.incarnation
        || offer.delivery_nonce != identity.delivery_nonce
        || offer.canonical_revision != identity.canonical_revision
        || offer.canonical_state_hash != identity.canonical_state_hash
    {
        return Err(Error::Identity);
    }
    if offer.sequence == 0 || offer.sequence > MAX_SAFE_INTEGER {
        return Err(Error::Bounds);
    }
    if offer.surface_id.is_nil() || offer.storage_ticket.is_nil() {
        return Err(Error::Ticket);
    }
    let snapshot = committed.snapshot.as_ref().ok_or(Error::Identity)?;
    if !offer.placement.fits(snapshot.rows, snapshot.cols) {
        return Err(Error::Bounds);
    }
    let layout = Layout {
        width: offer.width,
        height: offer.height,
        stride: offer.stride,
        allocation_bytes: offer.allocation_bytes,
    };
    let lease = pool.reserve(offer.sequence, layout)?;
    Ok(Accepted {
        pane: offer.pane,
        identity: Arc::clone(identity),
        sequence: offer.sequence,
        surface_id: offer.surface_id,
        placement: offer.placement,
        storage_ticket: offer.storage_ticket,
        layout,
        lease,
    })
}

#[cfg(test)]
#[path = "surface_offer_tests.rs"]
mod tests;
