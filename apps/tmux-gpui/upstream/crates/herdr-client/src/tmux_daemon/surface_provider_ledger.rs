use super::surface_provider::SurfaceProviderError as Error;
use crate::tmux_graphics::{surface_provider::Event, surface_provider_offer::Submission};
use std::collections::BTreeMap;
use uuid::Uuid;
struct Connection {
    panes: Vec<String>,
    frames: BTreeMap<u64, (usize, bool)>,
    last: u64,
    bytes: usize,
    stopped: bool,
}
#[derive(Default)]
pub(super) struct Ledger {
    connections: BTreeMap<Uuid, Connection>,
    watched: Option<Vec<String>>,
    required: Option<Vec<String>>,
    frames: usize,
    bytes: usize,
}
impl Ledger {
    pub(super) fn watch(&mut self, mut panes: Vec<String>) -> Result<bool, Error> {
        panes.sort();
        if let Some(current) = &self.watched {
            return if *current == panes {
                Ok(false)
            } else {
                Err(Error::Protocol)
            };
        }
        self.watched = Some(panes);
        Ok(true)
    }
    pub(super) fn kitty_required(&self, pane: &str) -> bool {
        !self
            .watched
            .as_ref()
            .is_some_and(|panes| panes.iter().any(|p| p == pane))
            || self
                .required
                .as_ref()
                .is_none_or(|panes| panes.iter().any(|p| p == pane))
    }

    pub(super) fn submit(&mut self, offer: &Submission, generation: Uuid) -> Result<(), Error> {
        let c = self
            .connections
            .get_mut(&offer.connection)
            .ok_or(Error::Protocol)?;
        if c.stopped
            || !c.panes.contains(&offer.pane)
            || offer.generation != generation.to_string()
            || offer.sequence <= c.last
            || c.frames.len() >= 8
            || self.frames >= 32
            || c.bytes + offer.allocation_bytes > 64 * 1024 * 1024
            || self.bytes + offer.allocation_bytes > 256 * 1024 * 1024
        {
            return Err(Error::Capacity);
        }
        c.last = offer.sequence;
        c.bytes += offer.allocation_bytes;
        self.bytes += offer.allocation_bytes;
        self.frames += 1;
        c.frames
            .insert(offer.sequence, (offer.allocation_bytes, false));
        Ok(())
    }
    pub(super) fn apply(&mut self, event: &mut Event) -> Result<(), Error> {
        match event {
            Event::KittyDemand { panes, required } => {
                panes.sort();
                if self.watched.as_ref() != Some(panes) {
                    return Err(Error::Protocol);
                }
                self.required = Some(required.clone());
            }

            Event::Registered { .. } => return Err(Error::Protocol),
            Event::Start {
                connection, panes, ..
            } => {
                if self.connections.len() >= 32 || self.connections.contains_key(connection) {
                    return Err(Error::Protocol);
                }
                self.connections.insert(
                    *connection,
                    Connection {
                        panes: panes.clone(),
                        frames: BTreeMap::new(),
                        bytes: 0,
                        last: 0,
                        stopped: false,
                    },
                );
            }
            Event::Offered {
                connection,
                sequence,
                accepted,
            } => {
                let c = self
                    .connections
                    .get_mut(connection)
                    .ok_or(Error::Protocol)?;
                let frame = c.frames.get_mut(sequence).ok_or(Error::Protocol)?;
                if frame.1 {
                    return Err(Error::Protocol);
                }
                if *accepted {
                    frame.1 = true;
                    // Revoked connections cannot authorize a delayed transfer.
                    // Keep accounting until close/retirement, even though caller
                    // may now discard this never-transferred backing.
                    if c.stopped {
                        *accepted = false;
                    }
                } else {
                    let bytes = frame.0;
                    c.frames.remove(sequence);
                    c.bytes -= bytes;
                    self.bytes -= bytes;
                    self.frames -= 1;
                }
            }
            Event::Retired {
                connection,
                sequence,
            } => {
                let c = self
                    .connections
                    .get_mut(connection)
                    .ok_or(Error::Protocol)?;
                let (bytes, accepted) = *c.frames.get(sequence).ok_or(Error::Protocol)?;
                if !accepted {
                    return Err(Error::Protocol);
                }
                c.frames.remove(sequence);
                c.bytes -= bytes;
                self.bytes -= bytes;
                self.frames -= 1;
            }
            Event::Fallback { connection } => {
                self.connections
                    .get_mut(connection)
                    .ok_or(Error::Protocol)?
                    .stopped = true;
            }
            Event::Close { connection } => {
                let c = self.connections.remove(connection).ok_or(Error::Protocol)?;
                self.bytes -= c.bytes;
                self.frames -= c.frames.len();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "surface_provider_ledger_tests.rs"]
mod tests;
