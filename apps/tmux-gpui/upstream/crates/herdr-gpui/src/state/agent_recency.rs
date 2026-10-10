//! When this client saw each agent last change state, on one clock every
//! connection shares. A daemon's `state_change_seq` counts only its own
//! changes, so an agents panel that merges several hosts by recency needs an
//! order across them, as Herdr's terminal client keeps one.

use herdr_client::protocol::ClientShellSnapshot;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};

/// Shared by every connection's reader thread, so changes on different hosts
/// order as they arrived here.
static CLOCK: AtomicU64 = AtomicU64::new(0);

/// Each listed agent's latest observed change, by pane; larger is newer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct AgentRecency(HashMap<String, u64>);

impl AgentRecency {
    /// Stamps the agents whose state changed since `previous`, the last
    /// snapshot from the same daemon boot, oldest change first, and forgets
    /// panes `next` no longer lists. Without one, every agent is new.
    pub(super) fn observe(
        &mut self,
        previous: Option<&ClientShellSnapshot>,
        next: &ClientShellSnapshot,
    ) {
        let mut changed: Vec<_> = next
            .agents
            .iter()
            .filter(|agent| {
                previous
                    .and_then(|previous| {
                        previous
                            .agents
                            .iter()
                            .find(|old| old.pane_id == agent.pane_id)
                    })
                    .is_none_or(|old| old.state_change_seq != agent.state_change_seq)
            })
            .collect();
        changed.sort_by_key(|agent| agent.state_change_seq);
        for agent in changed {
            let stamp = CLOCK.fetch_add(1, Ordering::Relaxed) + 1;
            self.0.insert(agent.pane_id.clone(), stamp);
        }
        self.0
            .retain(|pane_id, _| next.agents.iter().any(|agent| agent.pane_id == *pane_id));
    }

    /// The pane's latest observed change, or 0 when none was.
    pub(crate) fn of(&self, pane_id: &str) -> u64 {
        self.0.get(pane_id).copied().unwrap_or_default()
    }
}
