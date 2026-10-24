//! Ordered native terminal state behind the pane-stream transport.
//! The consumer may coalesce `Updated` notifications, never input wire events.
use crate::{tmux_delivery::Snapshot, tmux_receiver, tmux_stream};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::{collections::BTreeMap, sync::Arc};

const MAX_PENDING_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native terminal session has retired")]
    Retired,
    #[error("native terminal stream identity or ordering mismatch")]
    Identity,
    #[error("native terminal transaction budget exceeded")]
    Budget,
    #[error("terminal source is unavailable")]
    SourceClosed,
    #[error("invalid terminal negotiation")]
    Json(#[source] serde_json::Error),
    #[error("invalid terminal chunk encoding")]
    Base64(#[source] base64::DecodeError),
    #[error(transparent)]
    Delivery(#[from] tmux_receiver::Error),
}

pub enum Outcome {
    Pending,
    Materializing(String),
    Ready(tmux_stream::Ready),
    /// Send the ACK only after this result: the snapshot is already retained.
    Updated {
        pane: String,
        snapshot: Option<Arc<Snapshot>>,
        changed_rows: Vec<usize>,
        ack: tmux_receiver::Ack,
    },
    Projected {
        pane: String,
        snapshot: Option<Arc<Snapshot>>,
        changed_rows: Vec<usize>,
        receipt: tmux_receiver::ProjectionReceipt,
    },
    Control(Box<RawValue>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Negotiation {
    accepted: bool,
    negotiated: tmux_receiver::Negotiated,
}

pub struct TerminalState {
    generation: String,
    workspace: String,
    panes: Vec<String>,
    ready: bool,
    binary_cells: bool,
    alternate_screen_projection: bool,
    retired: bool,
    receivers: BTreeMap<String, tmux_receiver::Receiver>,
}

impl TerminalState {
    pub fn new(generation: String, workspace: String, panes: Vec<String>) -> Result<Self, Error> {
        Self::new_with_binary_cells(generation, workspace, panes, false)
    }
    pub fn new_with_binary_cells(
        generation: String,
        workspace: String,
        panes: Vec<String>,
        binary_cells: bool,
    ) -> Result<Self, Error> {
        Self::new_offered(generation, workspace, panes, binary_cells, false)
    }
    pub(crate) fn new_offered(
        generation: String,
        workspace: String,
        panes: Vec<String>,
        binary_cells: bool,
        alternate_screen_projection: bool,
    ) -> Result<Self, Error> {
        if alternate_screen_projection && !binary_cells {
            return Err(Error::Identity);
        }
        if generation.is_empty()
            || workspace.is_empty()
            || workspace.len() > 512
            || panes.is_empty()
            || panes.len() > 24
            || panes.iter().any(|p| p.is_empty() || p.len() > 128)
            || panes
                .iter()
                .enumerate()
                .any(|(i, p)| panes[..i].contains(p))
        {
            return Err(Error::Identity);
        }
        Ok(Self {
            generation,
            workspace,
            panes,
            ready: false,
            binary_cells,
            alternate_screen_projection,
            retired: false,
            receivers: BTreeMap::new(),
        })
    }
    pub fn retire(&mut self) {
        self.retired = true;
        self.receivers.clear();
    }
    pub fn snapshot(&self, pane: &str) -> Option<&Arc<Snapshot>> {
        self.receivers
            .get(pane)
            .and_then(tmux_receiver::Receiver::snapshot)
    }
    pub fn apply(&mut self, event: tmux_stream::Event) -> Result<Outcome, Error> {
        let result = self.apply_inner(event);
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn chunk(
        &mut self,
        pane: String,
        transaction_id: String,
        index: u8,
        bytes: Vec<u8>,
        binary: bool,
    ) -> Result<Outcome, Error> {
        let receiver = self.receivers.get_mut(&pane).ok_or(Error::Identity)?;
        if receiver.binary() != binary || (binary && !self.binary_cells) {
            return Err(Error::Identity);
        }
        if receiver.projection_pending() {
            if !binary || !self.alternate_screen_projection {
                return Err(Error::Identity);
            }
            return match receiver.projection_chunk(&transaction_id, usize::from(index), &bytes)? {
                Some(receipt) => Ok(Outcome::Projected {
                    pane,
                    snapshot: receiver.snapshot().cloned(),
                    changed_rows: receiver.changed_rows().to_vec(),
                    receipt,
                }),
                None => Ok(Outcome::Pending),
            };
        }
        match receiver.chunk(&transaction_id, usize::from(index), &bytes)? {
            Some(ack) => Ok(Outcome::Updated {
                pane,
                snapshot: receiver.snapshot().cloned(),
                changed_rows: receiver.changed_rows().to_vec(),
                ack,
            }),
            None => Ok(Outcome::Pending),
        }
    }
    fn apply_inner(&mut self, event: tmux_stream::Event) -> Result<Outcome, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if let tmux_stream::Event::Ready(ref ready) = event {
            if self.ready
                || ready.daemon_instance_id != self.generation
                || ready.panes != self.panes
            {
                return Err(Error::Identity);
            }
            self.ready = true;
            if let tmux_stream::Event::Ready(ready) = event {
                return Ok(Outcome::Ready(ready));
            }
            return Err(Error::Identity);
        }
        if !self.ready {
            return Err(Error::Identity);
        }
        match event {
            tmux_stream::Event::Ready(_) | tmux_stream::Event::GraphicsBinary(_) => {
                Err(Error::Identity)
            }
            tmux_stream::Event::DeliveryReady { pane, negotiation } => {
                if !self.panes.contains(&pane) || self.receivers.contains_key(&pane) {
                    return Err(Error::Identity);
                }
                let result: Negotiation =
                    serde_json::from_str(negotiation.get()).map_err(Error::Json)?;
                if (!self.alternate_screen_projection
                    && result.negotiated.alternate_screen_projection.is_some())
                    || !result.accepted
                    || result.negotiated.generation != self.generation
                    || (!self.binary_cells && result.negotiated.encoding == "semantic-binary-v1")
                {
                    return Err(Error::Identity);
                }
                let receiver = tmux_receiver::Receiver::new(
                    result.negotiated,
                    self.workspace.clone(),
                    pane.clone(),
                )?;
                self.receivers.insert(pane, receiver);
                Ok(Outcome::Pending)
            }
            tmux_stream::Event::ProjectionEnvelope { pane, envelope } => {
                if !self.alternate_screen_projection {
                    return Err(Error::Identity);
                }
                self.receivers
                    .get_mut(&pane)
                    .ok_or(Error::Identity)?
                    .begin_projection(envelope.get().as_bytes())?;
                if self
                    .receivers
                    .values()
                    .map(tmux_receiver::Receiver::pending_bytes)
                    .sum::<usize>()
                    > MAX_PENDING_BYTES
                {
                    return Err(Error::Budget);
                }
                Ok(Outcome::Pending)
            }
            tmux_stream::Event::Envelope { pane, envelope } => {
                let receiver = self.receivers.get_mut(&pane).ok_or(Error::Identity)?;
                let materializing = receiver.projection_receipt().is_some();
                receiver.begin(envelope.get().as_bytes())?;
                if self
                    .receivers
                    .values()
                    .map(tmux_receiver::Receiver::pending_bytes)
                    .sum::<usize>()
                    > MAX_PENDING_BYTES
                {
                    return Err(Error::Budget);
                }
                Ok(if materializing {
                    Outcome::Materializing(pane)
                } else {
                    Outcome::Pending
                })
            }
            tmux_stream::Event::Chunk {
                pane,
                transaction_id,
                index,
                data,
            } => {
                if data.len() > (256 * 1024_usize).div_ceil(3) * 4 {
                    return Err(Error::Budget);
                }
                let bytes = STANDARD.decode(data).map_err(Error::Base64)?;
                self.chunk(pane, transaction_id, index, bytes, false)
            }
            tmux_stream::Event::BinaryChunk {
                pane,
                transaction_id,
                index,
                data,
            } => self.chunk(pane, transaction_id, index, data, true),
            tmux_stream::Event::Control(value) => {
                #[derive(Deserialize)]
                struct Kind<'a> {
                    #[serde(rename = "type", borrow)]
                    kind: &'a str,
                }
                let kind: Kind<'_> = serde_json::from_str(value.get()).map_err(Error::Json)?;
                if matches!(kind.kind, "terminal-delivery-fault" | "error") {
                    return Err(Error::SourceClosed);
                }
                Ok(Outcome::Control(value))
            }
        }
    }
}

#[cfg(test)]
#[path = "tmux_terminal_tests.rs"]
mod tests;
