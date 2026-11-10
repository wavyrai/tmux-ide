//! A connection drop keeps what the window shows; a reset forgets it.
//!
//! The invariant: after a drop and a reconnect to the same daemon generation,
//! the view equals what a fresh load would give, and until then it shows the
//! last known state. After a different generation or identity, nothing kept
//! survives the first fresh catalog: agent contexts carry the catalog identity
//! (so a new one reconfigures the gate), and row ids are reused only for the
//! same identity (`receive_catalog`).
use super::*;

impl Local {
    /// Forgets every agent row and control: navigation or a different daemon.
    pub(super) fn forget_agents(&mut self) {
        self.agents.cancel();
        self.state.home_agents = None;
        self.state.workspace_agents = None;
        self.state.workspace_fleet_agents = None;
        self.state.workspace_fleet_agent_rejected = None;
        self.state.palette_agents = None;
        self.state.attention_agents = None;
        self.state.palette_selection_rejected = None;
        self.state.attention_selection_rejected = None;
    }
}
