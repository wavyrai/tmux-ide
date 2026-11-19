//! Capability 122, history on demand: a pane's older history rows come by
//! request, newest first, one request in flight per pane. Like
//! materialization it is a scoped read, never an input or a canonical ACK.
use super::*;
use crate::tmux_delivery::History;
use std::time::{Duration, Instant};

/// The first request after the seed's 200 rows, then larger chunks (design:
/// 500, then 2000).
pub(super) const FIRST_ROWS: usize = 500;
pub(super) const MORE_ROWS: usize = crate::tmux_receiver::HISTORY_CHUNK_MAX_ROWS;
/// A request the daemon has not answered (it ignores one with nothing to
/// send, or the stream moved on) may be asked again after this long.
const ASK_AGAIN: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
pub(super) struct Asked {
    incarnation: String,
    unloaded: usize,
    pub(super) at: Instant,
}
impl Controller {
    /// Asks for the newest of `pane`'s unloaded history rows. `true` while a
    /// request for them is in flight, sent now or before; `false` when the
    /// pane has nothing unloaded.
    pub fn request_history(&mut self, pane: &str, now: Instant) -> Result<bool, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        let Some(proof) = self.current.get(pane) else {
            return Ok(false);
        };
        let Some(snapshot) = &proof.snapshot else {
            return Ok(false);
        };
        let History::Partial(partial) = &snapshot.history else {
            return Ok(false);
        };
        if partial.unloaded.rows == 0 {
            self.history_requests.remove(pane);
            return Ok(false);
        }
        let identity = &proof.identity;
        if self.history_requests.get(pane).is_some_and(|asked| {
            asked.incarnation == identity.incarnation
                && asked.unloaded == partial.unloaded.rows
                && now.saturating_duration_since(asked.at) < ASK_AGAIN
        }) {
            return Ok(true);
        }
        let max_rows = if partial.loaded.len() < 200 + FIRST_ROWS {
            FIRST_ROWS
        } else {
            MORE_ROWS
        };
        let request = crate::tmux_receiver::HistoryRequest::new(
            self.policy.workspace(),
            pane,
            &identity.generation,
            &identity.incarnation,
            &identity.delivery_nonce,
            identity.canonical_revision,
            partial.unloaded.rows,
            max_rows,
        );
        let asked = Asked {
            incarnation: identity.incarnation.clone(),
            unloaded: partial.unloaded.rows,
            at: now,
        };
        let command = tmux_stream::Command::from_json(serde_json::to_string(
            &json!({"type":"terminal-delivery-history-request","request":request}),
        )?)?;
        if let Err(error) = self.session.try_send(command) {
            self.retire();
            return Err(Error::Session(error));
        }
        self.history_requests.insert(pane.into(), asked);
        Ok(true)
    }
    /// The pane's history rows not held here.
    pub fn unloaded_history(&self, pane: &str) -> usize {
        self.current
            .get(pane)
            .and_then(|proof| proof.snapshot.as_ref())
            .map_or(0, |snapshot| snapshot.history.unloaded_rows())
    }
}
