//! Session history contains stable keys, never reusable terminal capabilities.
use super::*;
use crate::tmux_snapshot::session_history::{Capability, Rejected};
#[path = "browser_native_local_tabs.rs"]
mod tabs;
const MAX: u64 = 9_007_199_254_740_991;
#[derive(Default)]
pub(super) struct Ledger {
    pub(super) tabs: tabs::Tabs,
    seeded: bool,
    entries: Vec<String>,
    index: Option<usize>,
    pending: Option<(u64, usize, String)>,
    accepted: Option<(u64, String)>,
    routes: BTreeMap<String, String>,
    cached_routes: BTreeMap<String, String>,
    pending_machine: Option<String>,
    retired: Option<u64>,
    highest_attempt: Option<u64>,
    revision: u64,
    publication: Option<(u64, Capability)>,
}
impl Ledger {
    pub(super) fn seed(&mut self, recent: &[String]) {
        if self.seeded {
            return;
        }
        self.seeded = true;
        for key in recent.iter().take(64) {
            if !self.entries.contains(key) {
                self.entries.push(key.clone());
            }
        }
        self.entries.reverse();
        self.index = self.entries.len().checked_sub(1);
        self.publication = None;
    }
    pub(super) fn cancel(&mut self) {
        self.tabs.cancel();
        self.pending_machine = None;
        if let Some((request, _, _)) = self.pending.take() {
            self.retired = Some(self.retired.map_or(request, |old| old.max(request)));
        }
        self.publication = None;
    }
    pub(super) fn accept(&mut self, request: u64, key: &str) -> bool {
        if !self.seeded
            || self.retired.is_some_and(|r| request <= r)
            || self
                .accepted
                .as_ref()
                .is_some_and(|(r, k)| *r == request && k == key)
        {
            return false;
        }
        if let Some((attempt, index, expected)) = &self.pending {
            if *attempt != request || expected != key {
                return false;
            }
            self.index = Some(*index);
            self.pending = None;
            self.pending_machine = None;
        } else if self
            .index
            .and_then(|i| self.entries.get(i))
            .is_none_or(|k| k != key)
        {
            self.entries.truncate(self.index.map_or(0, |i| i + 1));
            self.entries.push(key.into());
            if self.entries.len() > 64 {
                self.entries.remove(0);
            }
            self.index = self.entries.len().checked_sub(1);
        }
        self.routes.retain(|key, _| self.entries.contains(key));
        self.cached_routes
            .retain(|key, _| self.entries.contains(key));
        self.accepted = Some((request, key.into()));
        self.publication = None;
        true
    }
    pub(super) fn publication(&mut self, request: u64, available: bool) -> Option<Capability> {
        if !self.seeded || !available {
            self.publication = None;
            return None;
        }
        if self.publication.as_ref().is_none_or(|(r, _)| *r != request) {
            if self.revision == MAX {
                return None;
            }
            self.revision += 1;
            let back = self.pending.is_none() && self.index.is_some_and(|i| i > 0);
            let forward =
                self.pending.is_none() && self.index.is_some_and(|i| i + 1 < self.entries.len());
            self.publication = Some((
                request,
                Capability {
                    revision: self.revision,
                    back: back.then(|| uuid::Uuid::new_v4().to_string()),
                    forward: forward.then(|| uuid::Uuid::new_v4().to_string()),
                },
            ));
        }
        self.publication.as_ref().map(|(_, p)| p.clone())
    }
    fn admit(
        &mut self,
        command: &Rejected,
        current: u64,
        foreground: bool,
    ) -> Option<(usize, String)> {
        if !command.valid()
            || command.request <= current
            || self.highest_attempt.is_some_and(|r| command.request <= r)
        {
            return None;
        }
        self.highest_attempt = Some(command.request);
        let (published, capability) = self.publication.as_ref()?;
        if !foreground
            || command.from_request != current
            || *published != current
            || command.revision != capability.revision
            || self.pending.is_some()
        {
            return None;
        }
        let index = self.index?;
        let next = if capability.back.as_ref() == Some(&command.action) {
            index.checked_sub(1)?
        } else if capability.forward.as_ref() == Some(&command.action) {
            index.checked_add(1)?
        } else {
            return None;
        };
        Some((next, self.entries.get(next)?.clone()))
    }
    /// Cached aliases join only with the same verified environment and generation.
    /// The resulting locator still requires current registry and catalog proof.
    pub(super) fn cache_routes(&mut self, routes: &[herdr_client::tmux_daemon::FleetCachedRoute]) {
        use herdr_client::tmux_daemon::{FleetEnvironmentRoute, group_fleet_environments};
        let identities: Vec<_> = routes
            .iter()
            .map(|route| FleetEnvironmentRoute {
                id: &route.route_id,
                environment_id: route.environment_id.as_deref(),
                generation: route.generation.as_deref(),
                ready: false,
            })
            .collect();
        let groups = group_fleet_environments(&identities, "", &BTreeMap::new());
        let mut candidates: BTreeMap<String, Option<String>> = BTreeMap::new();
        for group in groups {
            for route in routes
                .iter()
                .filter(|route| group.route_ids.contains(&route.route_id.as_str()))
            {
                for session in &route.sessions {
                    if !self.entries.contains(&session.id) {
                        continue;
                    }
                    let machine = (!group.conflict).then_some(group.primary_route_id);
                    let candidate = candidates
                        .entry(session.id.clone())
                        .or_insert_with(|| machine.map(str::to_owned));
                    if candidate.as_deref() != machine {
                        *candidate = None;
                    }
                }
            }
        }
        self.cached_routes = candidates
            .into_iter()
            .filter_map(|(key, route)| route.map(|route| (key, route)))
            .collect();
    }
    fn machine(&self, key: &str) -> Option<&String> {
        self.routes.get(key).or_else(|| self.cached_routes.get(key))
    }
    pub(super) fn remember(&mut self, key: &str, machine: &str) {
        if self.entries.iter().any(|entry| entry == key) {
            self.routes.insert(key.into(), machine.into());
        }
    }
    pub(super) fn take_transition(
        &mut self,
        request: u64,
        machine: &str,
    ) -> Option<(u64, usize, String)> {
        if self.pending.as_ref().is_some_and(|(r, _, _)| *r == request)
            && self.pending_machine.as_deref() == Some(machine)
        {
            self.pending_machine = None;
            self.pending.take()
        } else {
            None
        }
    }
    pub(super) fn restore_transition(&mut self, pending: (u64, usize, String), machine: &str) {
        self.pending = Some(pending);
        self.pending_machine = Some(machine.into());
        self.publication = None;
    }
    fn begin(&mut self, request: u64, index: usize, key: String) {
        self.pending_machine = None;
        self.pending = Some((request, index, key));
        self.publication = None;
    }
}
impl Local {
    fn history_target(&self, key: &str) -> Option<String> {
        let identity = self.catalog_identity.as_ref()?;
        self.targets.iter().find_map(|(token, target)| {
            (identity
                .session_key(&self.machine_id, &target.scope, &target.live, false)
                .ok()
                .as_deref()
                == Some(key))
            .then(|| token.clone())
        })
    }
    pub(super) fn navigate_history(&mut self, command: Rejected) -> Result<(), Error> {
        let candidate = self
            .navigation
            .admit(&command, self.state.request, self.foreground);
        if let Some((index, key)) = candidate {
            if let Some(token) = self.history_target(&key) {
                self.open(command.request, token, None)?;
                self.navigation.begin(command.request, index, key);
                self.state.session_history_rejected = None;
                return self.publish();
            }
            if let Some(machine) = self.navigation.machine(&key).cloned()
                && machine != self.machine_id
            {
                if machine == "local" {
                    if self.local_record.is_some() {
                        self.switch_local(command.request)?;
                    }
                } else {
                    self.select_history_machine(command.request, machine.clone())?;
                }
                if self.state.request == command.request && self.stage.is_some() {
                    self.navigation
                        .restore_transition((command.request, index, key), &machine);
                    self.state.session_history_rejected = None;
                    return self.publish();
                }
            }
        }
        self.state.session_history_rejected = Some(command);
        self.state.status = "Visited session is unavailable — refresh its catalog".into();
        self.publish()
    }
    pub(super) fn navigate_catalog(&mut self) -> Result<bool, Error> {
        let Some((request, _, key)) = self.navigation.pending.as_ref() else {
            return Ok(false);
        };
        if *request != self.state.request
            || self.navigation.pending_machine.as_deref() != Some(&self.machine_id)
        {
            return Ok(false);
        }
        let Some(token) = self.history_target(key) else {
            self.unavailable("Visited session identity changed or disappeared — select a session")?;
            return Ok(true);
        };
        let request = *request;
        let pending = self.navigation.take_transition(request, &self.machine_id);
        self.open(request, token, None)?;
        if let Some(pending) = pending {
            self.navigation
                .restore_transition(pending, &self.machine_id);
        }
        Ok(true)
    }
}
#[cfg(test)]
#[path = "browser_native_local_navigation_tests.rs"]
mod tests;
