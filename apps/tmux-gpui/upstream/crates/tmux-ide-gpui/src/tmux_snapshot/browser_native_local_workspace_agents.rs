//! Workspace fleet publication shares observations, but has its own navigation scope.
use super::*;
use crate::tmux_snapshot::workspace_fleet_agents::{Publication, Rejected};
#[path = "browser_native_local_agent_groups.rs"]
mod groups;
const MAX: u64 = 9_007_199_254_740_991;
impl Gate {
    fn workspace_keys(
        &self,
        machine: &str,
        identity: &CatalogIdentity,
        scope: &ServerScope,
        live: &str,
    ) -> std::collections::BTreeSet<String> {
        let Some(slot) = self.slots.iter().find(|s| {
            s.context.machine == machine
                && &s.context.catalog_identity == identity
                && &s.context.scope == scope
                && s.context.live == live
        }) else {
            return Default::default();
        };
        let Observed::Ready(result) = &slot.observed else {
            return Default::default();
        };
        result
            .agents
            .iter()
            .map(|agent| self.row_key(&slot.context, agent))
            .collect()
    }
    fn workspace_scope(&mut self, request: u64) -> Option<u64> {
        if let Some((_, scope)) = self.workspace_scope.filter(|(r, _)| *r == request) {
            return Some(scope);
        }
        if self.next_workspace_scope == MAX {
            return None;
        }
        self.next_workspace_scope += 1;
        self.workspace_scope = Some((request, self.next_workspace_scope));
        Some(self.next_workspace_scope)
    }
    fn admit_workspace(&mut self, command: &Rejected, current: u64, foreground: bool) -> bool {
        if !command.valid()
            || command.request <= current
            || command.request <= self.workspace_attempt
        {
            return false;
        }
        self.workspace_attempt = command.request;
        foreground
            && command.from_request == current
            && self.workspace_scope == Some((current, command.scope))
    }
}
impl Local {
    pub(in super::super) fn workspace_catalog_observing(&self) -> bool {
        self.state.surface == Surface::Workspace
            && self.active.is_some()
            && !self.agents.catalog_unavailable
    }
    pub(in super::super) fn workspace_catalog_failed(&mut self) -> Result<(), Error> {
        self.agents.catalog_unavailable = true;
        self.agents.catalog.clear();
        self.agents.catalog_total = 0;
        self.agents.suspend();
        if self.picker_observing() {
            self.picker_catalog_failed()
        } else {
            self.agent_tick()
        }
    }
    pub(super) fn publish_workspace_agents(&mut self, mut roster: home_agents::Roster) {
        let Some(scope) = self.agents.workspace_scope(self.state.request) else {
            return;
        };
        self.agents.group_workspace_rows(&mut roster.rows);
        let keys = self.active_agent_keys();
        self.state.workspace_agents = self.active.as_ref().map(|route| {
            let mut local = roster.clone();
            local.rows.retain(|row| keys.contains(&row.key));
            let slot = self.agents.slots.iter().find(|s| {
                s.context.machine == self.machine_id
                    && s.context.scope == route.target.scope
                    && s.context.live == route.target.live
            });
            local.total_sessions = 1;
            local.observed_sessions =
                u64::from(slot.is_some_and(|s| matches!(s.observed, Observed::Ready(_))));
            local.truncated_sessions = 0;
            home_agents::WorkspaceRoster {
                session_id: route.target.live.clone(),
                roster: local,
            }
        });
        let mut sessions = BTreeMap::new();
        for slot in &self.agents.slots {
            let Observed::Ready(result) = &slot.observed else {
                continue;
            };
            for agent in &result.agents {
                let key = self.agents.row_key(&slot.context, agent);
                if roster.rows.iter().any(|r| r.key == key) {
                    sessions.insert(
                        key,
                        crate::tmux_snapshot::workspace_fleet_agents::SessionScope {
                            machine: slot.context.machine.clone(),
                            server: slot.context.scope.server_id.clone(),
                            generation: slot.context.scope.generation.clone(),
                            session: slot.context.live.clone(),
                        },
                    );
                }
            }
        }
        self.state.workspace_fleet_agents = Some(Publication {
            request: self.state.request,
            scope,
            roster,
            selected_key: None,
            sessions,
        });
    }
    fn active_agent_keys(&self) -> std::collections::BTreeSet<String> {
        let Some(route) = &self.active else {
            return Default::default();
        };
        let Some(identity) = &self.catalog_identity else {
            return Default::default();
        };
        self.agents.workspace_keys(
            &self.machine_id,
            identity,
            &route.target.scope,
            &route.target.live,
        )
    }
    pub(in super::super) fn refresh_workspace_agent_selection(&self, state: &mut State) {
        let Some(publication) = &mut state.workspace_fleet_agents else {
            return;
        };
        let keys = self.active_agent_keys();
        let mut candidates =
            publication.roster.rows.iter().filter(|r| {
                r.available && r.pane_id == state.selected_pane && keys.contains(&r.key)
            });
        let first = candidates.next();
        publication.selected_key = first
            .filter(|_| candidates.next().is_none())
            .map(|r| r.key.clone());
    }
    pub(in super::super) fn open_workspace_fleet_agent(
        &mut self,
        command: Command,
    ) -> Result<(), Error> {
        let Command::OpenWorkspaceFleetAgent {
            request,
            from_request,
            scope,
            roster_revision,
            key,
        } = command
        else {
            return Ok(());
        };
        let attempt = Rejected {
            request,
            from_request,
            scope,
            roster_revision,
            key,
        };
        if !attempt.valid() {
            return Ok(());
        }
        let admitted = self
            .agents
            .admit_workspace(&attempt, self.state.request, self.foreground)
            && self.stage.is_none()
            && self.state.surface == Surface::Workspace
            && self.state.workspace_fleet_agents.as_ref().is_some_and(|p| {
                p.scope == scope
                    && p.request == from_request
                    && p.roster.revision == roster_revision
                    && p.roster
                        .rows
                        .iter()
                        .any(|r| r.key == attempt.key && r.available)
            });
        if admitted
            && let Some((context, agent)) = self.agents.resolve(&attempt.key, roster_revision)
            && self.open_agent_target(request, context, agent)?
        {
            return Ok(());
        }
        self.state.workspace_fleet_agent_rejected = Some(attempt);
        self.publish()
    }
}
#[cfg(test)]
#[path = "browser_native_local_workspace_agents_tests.rs"]
mod tests;
