//! Observation recovery never reconnects a route or changes terminal ownership.
use super::*;
use crate::tmux_snapshot::home::recovery::{Action, Capability};
impl Gate {
    pub(super) fn clear_controls(&mut self) {
        self.control_first = None;
        self.retry_first = None;
        self.load_first = None;
    }
    pub(super) fn record_controls(&mut self) {
        self.control_first.get_or_insert(self.revision);
        let cap = self.recovery_capability(self.revision);
        if cap.can_retry {
            self.retry_first.get_or_insert(self.revision);
        } else {
            self.retry_first = None;
        }
        if cap.can_load_more {
            self.load_first.get_or_insert(self.revision);
        } else {
            self.load_first = None;
        }
    }
    pub(super) fn control_current(&self, revision: u64) -> bool {
        self.enabled
            && revision <= self.revision
            && self.control_first.is_some_and(|first| revision >= first)
    }

    pub(super) fn session_limit(&self) -> usize {
        32usize
            .saturating_add(self.extra_sessions)
            .min(MAX_AGENT_OBSERVATION_SESSIONS)
    }
    pub(super) fn recovery_capability(&self, revision: u64) -> Capability {
        Capability {
            revision,
            can_retry: self
                .slots
                .iter()
                .any(|s| matches!(s.observed, Observed::Failed)),
            can_load_more: self.total > self.contexts.len()
                && self.session_limit() < MAX_AGENT_OBSERVATION_SESSIONS,
        }
    }
    pub(super) fn recover(&mut self, revision: u64, action: Action) -> bool {
        if !self.control_current(revision) || self.workspace {
            return false;
        }
        let cap = self.recovery_capability(revision);
        match action {
            Action::Retry
                if cap.can_retry && self.retry_first.is_some_and(|first| revision >= first) => {}
            Action::LoadMore
                if cap.can_load_more && self.load_first.is_some_and(|first| revision >= first) =>
            {
                self.extra_sessions = self
                    .session_limit()
                    .saturating_add(32)
                    .min(MAX_AGENT_OBSERVATION_SESSIONS)
                    - 32;
            }
            _ => return false,
        }
        // Revoke the old publication before restarting. Retiring workers still
        // occupy the shared pool's four-read concurrency budget.
        self.suspend();
        true
    }
}
impl Local {
    pub(in super::super) fn recover_agents(
        &mut self,
        request: u64,
        revision: u64,
        action: Action,
    ) -> Result<(), Error> {
        if !self.foreground
            || self.state.surface != Surface::Home
            || self.state.home_phase != HomePhase::Live
            || request != self.state.request
            || self.state.home_agents.is_none()
            || !self.agents.recover(revision, action)
        {
            return Ok(());
        }
        self.state.home_agents = None;
        self.agent_tick()
    }
}
