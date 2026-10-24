//! One pane's authenticated terminal transaction. A new connection needs a new receiver.
//! ACKs describe retained canonical state, never GPU presentation.
mod projection;
use crate::tmux_delivery::{self, Snapshot, Store, Update};
pub use projection::ProjectionReceipt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const CHUNK_BYTES: usize = 256 * 1024;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_REVISION: u64 = (1_u64 << 53) - 1;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("terminal receiver has retired")]
    Retired,
    #[error("invalid terminal negotiation or identity")]
    Identity,
    #[error("terminal delivery ordering mismatch")]
    Ordering,
    #[error("terminal transaction exceeds bounds")]
    Bounds,
    #[error("terminal representation hash mismatch")]
    RepresentationHash,
    #[error("invalid terminal envelope")]
    Envelope(#[source] serde_json::Error),
    #[error("invalid canonical terminal update")]
    Canonical(#[from] tmux_delivery::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Negotiated {
    pub protocol_version: u32,
    pub encoding: String,
    pub fallback_encoding: Option<String>,
    pub rich_placements: bool,
    pub generation: String,
    pub delivery_nonce: String,
    #[serde(default)]
    pub alternate_screen_projection: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Frame {
    Seed,
    Patch,
    Tombstone,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Envelope {
    #[serde(rename = "type")]
    kind: String,
    workspace_name: String,
    semantic_pane_id: String,
    generation: String,
    incarnation: String,
    delivery_nonce: String,
    transaction_id: String,
    performance_trace_id: Option<String>,
    causal_cell_proof: Option<Box<serde_json::value::RawValue>>,
    protocol_version: u32,
    encoding: String,
    frame: Frame,
    base_revision: Option<i64>,
    canonical_revision: u64,
    canonical_state_hash: String,
    representation_hash: String,
    representation_bytes: usize,
    chunk_count: usize,
    canonical_equivalent: bool,
    history: String,
    rich_placements: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
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
    pub representation_hash: String,
}

struct Pending {
    envelope: Envelope,
    bytes: Vec<u8>,
    next_chunk: usize,
}

pub struct Receiver {
    negotiated: Negotiated,
    workspace: String,
    pane: String,
    incarnation: Option<String>,
    revision: Option<u64>,
    tombstoned: bool,
    retired: bool,
    store: Store,
    changed_rows: Vec<usize>,
    pending: Option<Pending>,
    partial: Option<projection::Partial>,
}

fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}
fn hash(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn newer_incarnation(old: &str, new: &str) -> bool {
    let epoch = |v: &str| {
        v.rsplit_once(':').and_then(|(_, n)| {
            if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            n.parse::<u64>().ok()
        })
    };
    matches!((epoch(old), epoch(new)), (Some(a), Some(b)) if b > a && b <= MAX_REVISION)
}

impl Receiver {
    pub fn new(negotiated: Negotiated, workspace: String, pane: String) -> Result<Self> {
        if negotiated.protocol_version != 1
            || !matches!(
                negotiated.encoding.as_str(),
                "semantic-compact-v1" | "semantic-binary-v1"
            )
            || negotiated
                .alternate_screen_projection
                .as_ref()
                .is_some_and(|s| {
                    s != "deferred-history-v1" || negotiated.encoding != "semantic-binary-v1"
                })
            || negotiated.fallback_encoding.is_some()
            || !uuid(&negotiated.delivery_nonce)
            || negotiated.generation.is_empty()
            || workspace.is_empty()
            || pane.is_empty()
            || workspace.len() > 512
            || pane.len() > 512
            || negotiated.generation.len() > 256
        {
            return Err(Error::Identity);
        }
        Ok(Self {
            negotiated,
            workspace,
            pane,
            incarnation: None,
            revision: None,
            tombstoned: false,
            retired: false,
            store: Store::default(),
            changed_rows: Vec::new(),
            pending: None,
            partial: None,
        })
    }

    /// Failed receivers expose no actionable terminal state. Retained external Arcs are preview only.
    pub fn snapshot(&self) -> Option<&Arc<Snapshot>> {
        if self.retired {
            None
        } else {
            self.partial
                .as_ref()
                .and_then(|p| p.store.snapshot())
                .or_else(|| self.store.snapshot())
        }
    }
    pub fn revision(&self) -> Option<u64> {
        if self.retired { None } else { self.revision }
    }
    pub fn incarnation(&self) -> Option<&str> {
        if self.retired {
            None
        } else {
            self.incarnation.as_deref()
        }
    }
    pub fn changed_rows(&self) -> &[usize] {
        &self.changed_rows
    }
    pub(crate) fn binary(&self) -> bool {
        self.negotiated.encoding == "semantic-binary-v1"
    }
    pub fn pending_bytes(&self) -> usize {
        let projection = self
            .partial
            .as_ref()
            .and_then(|p| p.pending.as_ref())
            .map_or(0, |p| p.envelope.representation_bytes);
        projection
            + self
                .pending
                .as_ref()
                .map_or(0, |p| p.envelope.representation_bytes)
    }
    pub fn retire(&mut self) {
        self.retired = true;
        self.pending = None;
        self.store = Store::default();
        self.partial = None;
    }

    pub fn begin(&mut self, bytes: &[u8]) -> Result<()> {
        let result = self.begin_inner(bytes);
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn begin_inner(&mut self, bytes: &[u8]) -> Result<()> {
        if self.retired {
            return Err(Error::Retired);
        }
        if self.pending.is_some() || self.projection_pending() {
            return Err(Error::Ordering);
        }
        if bytes.len() > 1024 * 1024 {
            return Err(Error::Bounds);
        }
        let e: Envelope = serde_json::from_slice(bytes).map_err(Error::Envelope)?;
        if e.kind != "terminal.delivery"
            || e.protocol_version != 1
            || e.encoding != self.negotiated.encoding
            || e.generation != self.negotiated.generation
            || e.delivery_nonce != self.negotiated.delivery_nonce
            || e.workspace_name != self.workspace
            || e.semantic_pane_id != self.pane
            || e.rich_placements != self.negotiated.rich_placements
            || !e.canonical_equivalent
            || e.incarnation.is_empty()
            || e.incarnation.len() > 256
            || !uuid(&e.transaction_id)
            || !hash(&e.canonical_state_hash)
            || !hash(&e.representation_hash)
            || e.performance_trace_id.as_ref().is_some_and(|v| !uuid(v))
        {
            return Err(Error::Identity);
        }
        // Diagnostics never participate in input authority or canonical validation.
        let _ = &e.causal_cell_proof;
        if e.representation_bytes > MAX_BYTES
            || e.chunk_count != e.representation_bytes.div_ceil(CHUNK_BYTES).max(1)
            || e.canonical_revision > MAX_REVISION
        {
            return Err(Error::Bounds);
        }
        if e.history
            != if e.frame == Frame::Tombstone {
                "not-applicable"
            } else {
                "complete"
            }
        {
            return Err(Error::Identity);
        }
        if let Some(receipt) = self.projection_receipt()
            && (e.frame != Frame::Seed
                || e.incarnation != receipt.incarnation
                || e.canonical_revision < receipt.canonical_revision
                || (e.canonical_revision == receipt.canonical_revision
                    && e.canonical_state_hash != receipt.canonical_state_hash)
                || self.tombstoned)
        {
            return Err(Error::Ordering);
        }
        if e.frame == Frame::Seed {
            if e.base_revision.is_some() {
                return Err(Error::Ordering);
            }
            if let Some(old) = &self.incarnation
                && ((old == &e.incarnation && self.tombstoned)
                    || (old != &e.incarnation && !newer_incarnation(old, &e.incarnation))
                    || self.revision.is_some_and(|v| e.canonical_revision <= v))
            {
                return Err(Error::Ordering);
            }
        } else if self.tombstoned
            || self.incarnation.as_ref() != Some(&e.incarnation)
            || self.revision.map(|v| v as i64) != e.base_revision
            || self.revision.is_none()
            || self.revision.is_some_and(|v| e.canonical_revision <= v)
        {
            return Err(Error::Ordering);
        }
        self.pending = Some(Pending {
            bytes: Vec::with_capacity(e.representation_bytes),
            envelope: e,
            next_chunk: 0,
        });
        Ok(())
    }

    pub fn chunk(&mut self, transaction: &str, index: usize, bytes: &[u8]) -> Result<Option<Ack>> {
        let result = self.chunk_inner(transaction, index, bytes);
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn chunk_inner(
        &mut self,
        transaction: &str,
        index: usize,
        bytes: &[u8],
    ) -> Result<Option<Ack>> {
        if self.retired {
            return Err(Error::Retired);
        }
        let p = self.pending.as_mut().ok_or(Error::Ordering)?;
        let e = &p.envelope;
        let remaining = e.representation_bytes.saturating_sub(p.bytes.len());
        if transaction != e.transaction_id
            || index != p.next_chunk
            || index >= e.chunk_count
            || bytes.len() != CHUNK_BYTES.min(remaining)
        {
            return Err(Error::Ordering);
        }
        p.bytes.extend_from_slice(bytes);
        p.next_chunk += 1;
        if p.next_chunk != e.chunk_count {
            return Ok(None);
        }
        let p = self.pending.take().ok_or(Error::Ordering)?;
        let e = p.envelope;
        if p.bytes.len() != e.representation_bytes
            || tmux_delivery::hash_representation(&p.bytes) != e.representation_hash
        {
            return Err(Error::RepresentationHash);
        }
        let update = match self.negotiated.encoding.as_str() {
            "semantic-binary-v1" => tmux_delivery::decode_binary(&p.bytes)?,
            "semantic-compact-v1" => tmux_delivery::decode_compact(&p.bytes)?,
            _ => return Err(Error::Identity),
        };
        let (frame, base, revision) = match &update {
            Update::Seed { revision, .. } => (Frame::Seed, None, *revision),
            Update::Patch {
                base_revision,
                revision,
                ..
            } => (Frame::Patch, Some(*base_revision as i64), *revision),
            Update::Tombstone {
                base_revision,
                revision,
                ..
            } => (Frame::Tombstone, Some(*base_revision as i64), *revision),
        };
        if frame != e.frame || base != e.base_revision || revision != e.canonical_revision {
            return Err(Error::Ordering);
        }
        let applied = self.store.apply(update, &e.canonical_state_hash)?;
        self.partial = None;
        self.changed_rows = applied.changed_rows;
        self.incarnation = Some(e.incarnation.clone());
        self.revision = Some(revision);
        self.tombstoned = frame == Frame::Tombstone;
        Ok(Some(Ack {
            kind: "terminal.delivery.ack",
            workspace_name: e.workspace_name,
            semantic_pane_id: e.semantic_pane_id,
            generation: e.generation,
            incarnation: e.incarnation,
            delivery_nonce: e.delivery_nonce,
            transaction_id: e.transaction_id,
            canonical_revision: revision,
            canonical_state_hash: e.canonical_state_hash,
            representation_hash: e.representation_hash,
        }))
    }
}

#[cfg(test)]
#[path = "tmux_receiver_tests.rs"]
mod tests;
