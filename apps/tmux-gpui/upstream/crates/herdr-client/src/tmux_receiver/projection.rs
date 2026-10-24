//! Independent partial-state transaction lane; never produces a canonical ACK.
use super::*;
use crate::tmux_delivery::{ProjectionStore, decode_projection};
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionReceipt {
    #[serde(rename = "type")]
    kind: &'static str,
    pub workspace_name: String,
    pub semantic_pane_id: String,
    pub generation: String,
    pub incarnation: String,
    pub delivery_nonce: String,
    pub transaction_id: String,
    pub canonical_revision: u64,
    pub canonical_state_hash: String,
    pub projection_state_hash: String,
    pub representation_hash: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct ProjectionEnvelope {
    #[serde(rename = "type")]
    kind: String,
    workspace_name: String,
    semantic_pane_id: String,
    generation: String,
    incarnation: String,
    delivery_nonce: String,
    transaction_id: String,
    canonical_revision: u64,
    canonical_state_hash: String,
    projection_state_hash: String,
    representation_hash: String,
    protocol_version: u32,
    encoding: String,
    frame: Frame,
    base_revision: Option<u64>,
    pub(super) representation_bytes: usize,
    chunk_count: usize,
    canonical_equivalent: bool,
    history: String,
    rich_placements: bool,
}
pub(super) struct ProjectionPending {
    pub(super) envelope: ProjectionEnvelope,
    bytes: Vec<u8>,
    next: usize,
}
#[derive(Default)]
pub(super) struct Partial {
    pub(super) store: ProjectionStore,
    pub(super) pending: Option<ProjectionPending>,
    receipt: Option<ProjectionReceipt>,
}
impl Receiver {
    pub fn begin_projection(&mut self, bytes: &[u8]) -> Result<()> {
        let result = self.begin_projection_inner(bytes);
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn begin_projection_inner(&mut self, bytes: &[u8]) -> Result<()> {
        if self.retired {
            return Err(Error::Retired);
        }
        if self.negotiated.alternate_screen_projection.as_deref() != Some("deferred-history-v1")
            || self.store.snapshot().is_some()
            || self.pending.is_some()
        {
            return Err(Error::Identity);
        }
        if bytes.len() > 1024 * 1024 {
            return Err(Error::Bounds);
        }
        let e: ProjectionEnvelope = serde_json::from_slice(bytes).map_err(Error::Envelope)?;
        if e.kind != "terminal.projection"
            || e.protocol_version != 1
            || e.encoding != "alternate-projection-binary-v1"
            || e.history != "deferred"
            || e.canonical_equivalent
            || e.workspace_name != self.workspace
            || e.semantic_pane_id != self.pane
            || e.generation != self.negotiated.generation
            || e.delivery_nonce != self.negotiated.delivery_nonce
            || e.rich_placements != self.negotiated.rich_placements
            || e.incarnation.is_empty()
            || e.incarnation.len() > 256
            || !uuid(&e.transaction_id)
            || !hash(&e.canonical_state_hash)
            || !hash(&e.projection_state_hash)
            || !hash(&e.representation_hash)
        {
            return Err(Error::Identity);
        }
        if e.canonical_revision > MAX_REVISION
            || e.representation_bytes == 0
            || e.representation_bytes > MAX_BYTES
            || e.chunk_count != e.representation_bytes.div_ceil(CHUNK_BYTES)
        {
            return Err(Error::Bounds);
        }
        let partial = self.partial.get_or_insert_with(Partial::default);
        if partial.pending.is_some() || self.tombstoned {
            return Err(Error::Ordering);
        }
        if e.frame == Frame::Seed {
            if e.base_revision.is_some()
                || partial.receipt.as_ref().is_some_and(|r| {
                    r.incarnation != e.incarnation
                        || e.canonical_revision < r.canonical_revision
                        || (e.canonical_revision == r.canonical_revision
                            && (e.canonical_state_hash != r.canonical_state_hash
                                || e.projection_state_hash != r.projection_state_hash))
                })
            {
                return Err(Error::Ordering);
            }
        } else if partial.receipt.as_ref().is_none_or(|r| {
            r.incarnation != e.incarnation
                || Some(r.canonical_revision) != e.base_revision
                || e.canonical_revision <= r.canonical_revision
        }) {
            return Err(Error::Ordering);
        }
        partial.pending = Some(ProjectionPending {
            bytes: Vec::with_capacity(e.representation_bytes),
            envelope: e,
            next: 0,
        });
        Ok(())
    }
    pub fn projection_pending(&self) -> bool {
        self.partial.as_ref().is_some_and(|p| p.pending.is_some())
    }
    pub fn projection_receipt(&self) -> Option<&ProjectionReceipt> {
        self.partial.as_ref()?.receipt.as_ref()
    }
    pub fn projection_chunk(
        &mut self,
        transaction: &str,
        index: usize,
        bytes: &[u8],
    ) -> Result<Option<ProjectionReceipt>> {
        let result = self.projection_chunk_inner(transaction, index, bytes);
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn projection_chunk_inner(
        &mut self,
        transaction: &str,
        index: usize,
        bytes: &[u8],
    ) -> Result<Option<ProjectionReceipt>> {
        if self.retired {
            return Err(Error::Retired);
        }
        let partial = self.partial.as_mut().ok_or(Error::Ordering)?;
        let p = partial.pending.as_mut().ok_or(Error::Ordering)?;
        let e = &p.envelope;
        if transaction != e.transaction_id
            || index != p.next
            || index >= e.chunk_count
            || bytes.len() != CHUNK_BYTES.min(e.representation_bytes.saturating_sub(p.bytes.len()))
        {
            return Err(Error::Ordering);
        }
        p.bytes.extend_from_slice(bytes);
        p.next += 1;
        if p.next != e.chunk_count {
            return Ok(None);
        }
        let p = partial.pending.take().ok_or(Error::Ordering)?;
        let e = p.envelope;
        if tmux_delivery::hash_representation(&p.bytes) != e.representation_hash {
            return Err(Error::RepresentationHash);
        }
        let update = decode_projection(&p.bytes)?;
        let frame = match e.frame {
            Frame::Seed => "seed",
            Frame::Patch => "patch",
            Frame::Tombstone => "tombstone",
        };
        if update.frame() != frame
            || update.revision() != e.canonical_revision
            || update.base_revision() != e.base_revision
        {
            return Err(Error::Ordering);
        }
        self.changed_rows =
            partial
                .store
                .apply(update, &e.canonical_state_hash, &e.projection_state_hash)?;
        self.tombstoned = e.frame == Frame::Tombstone;
        let receipt = ProjectionReceipt {
            kind: "terminal.projection.receipt",
            workspace_name: e.workspace_name,
            semantic_pane_id: e.semantic_pane_id,
            generation: e.generation,
            incarnation: e.incarnation,
            delivery_nonce: e.delivery_nonce,
            transaction_id: e.transaction_id,
            canonical_revision: e.canonical_revision,
            canonical_state_hash: e.canonical_state_hash,
            projection_state_hash: e.projection_state_hash,
            representation_hash: e.representation_hash,
        };
        partial.receipt = Some(receipt.clone());
        Ok(Some(receipt))
    }
}
