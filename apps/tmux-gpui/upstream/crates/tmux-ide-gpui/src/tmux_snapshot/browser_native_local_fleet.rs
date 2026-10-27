//! Background fleet metadata and fresh-connection selection continuations.
use super::*;
use herdr_client::tmux_daemon::{
    CatalogIdentity, FleetCatalog, FleetEnvironmentRoute, group_fleet_environments,
};
use std::collections::BTreeSet;
#[path = "browser_native_local_fleet_agents.rs"]
mod agents;
#[path = "browser_native_local_fleet_recovery.rs"]
mod recovery;
#[derive(Clone, PartialEq, Eq)]
struct Selection {
    machine: String,
    incarnation: uuid::Uuid,
    target: CatalogTarget,
}
#[derive(Clone, PartialEq, Eq)]
enum CatalogTarget {
    Agent {
        scope: ServerScope,
        selection: Box<herdr_client::tmux_daemon::AgentSelection>,
    },
    Session(String),
    Server(ServerScope),
}
#[derive(Clone, PartialEq, Eq)]
struct Control {
    machine: String,
    incarnation: uuid::Uuid,
    retry: bool,
    selected: bool,
}
#[cfg(unix)]
pub(super) type Handle = Arc<Mutex<herdr_client::tmux_daemon::FleetRegistry>>;
#[derive(Default)]
pub(super) struct Gate {
    #[cfg(unix)]
    registry: Option<Handle>,
    labels: BTreeMap<String, (String, uuid::Uuid)>,
    catalogs: BTreeMap<String, FleetCatalog>,
    agent_groups: BTreeMap<String, bool>,
    failed: BTreeSet<String>,
    selections: BTreeMap<String, Selection>,
    pending: Option<(u64, String, CatalogTarget)>,
    conflict: bool,
    refresh_requested: bool,
    disconnected: BTreeSet<String>,
    controls: BTreeMap<String, Control>,
    pending_control: Option<(u64, Control)>,
    selected_epoch: uuid::Uuid,
    recovery: recovery::Retries,
}
impl Gate {
    pub(super) fn tab_catalogs(&self) -> impl Iterator<Item = (&str, &str, &FleetCatalog)> {
        self.catalogs.iter().filter_map(|(id, catalog)| {
            if self.failed.contains(id) || self.disconnected.contains(id) || self.conflict {
                return None;
            }
            self.labels
                .get(id)
                .map(|(label, _)| (id.as_str(), label.as_str(), catalog))
        })
    }

    pub(super) fn preference_key(
        &self,
        id: &str,
        conflict: bool,
        selected: &str,
        identity: Option<&CatalogIdentity>,
    ) -> String {
        if conflict {
            return id.into();
        }
        let identity = if id == selected {
            identity
        } else {
            self.catalogs.get(id).map(|catalog| &catalog.identity)
        };
        identity
            .map_or(id, |identity| identity.group_key(id))
            .to_owned()
    }

    pub(super) fn allows_current(&self) -> bool {
        !self.conflict
    }
    pub(super) fn busy(&self) -> bool {
        #[cfg(unix)]
        {
            self.registry
                .as_ref()
                .is_some_and(|registry| registry.lock().is_ok_and(|registry| registry.busy()))
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
    fn reconcile(
        &mut self,
        record: Option<&PathBuf>,
        value: herdr_client::tmux_daemon::SavedMachineRegistry,
        selected: &str,
    ) -> Result<(), Error> {
        #[cfg(unix)]
        if let Some(record) = record {
            let registry = self.registry.get_or_insert_with(|| {
                Arc::new(Mutex::new(
                    herdr_client::tmux_daemon::FleetRegistry::new_watched(record.clone()),
                ))
            });
            let mut registry = registry
                .lock()
                .map_err(|_| Error::Invalid("fleet owner closed"))?;
            registry.reconcile(value, selected)?;
            if std::mem::take(&mut self.refresh_requested) {
                for id in &self.failed {
                    if let Some((_, incarnation)) = self.labels.get(id) {
                        registry.retry(id, *incarnation)?;
                    }
                }
                registry.refresh()?;
            }
            let labels: BTreeMap<_, _> = registry
                .routes()
                .map(|(id, label, incarnation)| (id.to_owned(), (label.to_owned(), incarnation)))
                .collect();
            self.catalogs
                .retain(|id, _| self.labels.get(id).map(|v| v.1) == labels.get(id).map(|v| v.1));
            self.failed
                .retain(|id| self.labels.get(id).map(|v| v.1) == labels.get(id).map(|v| v.1));
            self.selections.retain(|_, selection| {
                labels
                    .get(&selection.machine)
                    .is_some_and(|v| v.1 == selection.incarnation)
            });
            self.disconnected = labels
                .keys()
                .filter(|id| registry.disconnected(id))
                .cloned()
                .collect();
            self.recovery.retain(&labels, &self.disconnected);
            self.labels = labels;
        }
        #[cfg(not(unix))]
        let _ = (record, value, selected);
        Ok(())
    }
    pub(super) fn refresh(&mut self) {
        // Wait for the Home operation's fresh local registry read before retrying
        // failed routes; never reconnect from an old saved-profile publication.
        self.recovery = Default::default();
        self.refresh_requested = true;
    }
    pub(super) fn invalidate(&mut self) -> Result<(), Error> {
        self.recovery = Default::default();
        self.refresh_requested = false;
        self.pending_control = None;
        self.controls.clear();
        self.disconnected.clear();
        self.labels.clear();
        self.catalogs.clear();
        self.agent_groups.clear();
        self.failed.clear();
        self.selections.clear();
        #[cfg(unix)]
        if let Some(registry) = &mut self.registry {
            registry
                .lock()
                .map_err(|_| Error::Invalid("fleet owner closed"))?
                .invalidate()?;
        }
        Ok(())
    }
    fn poll(&mut self) -> Result<bool, Error> {
        #[cfg(unix)]
        let mut changed = false;
        #[cfg(not(unix))]
        let changed = false;
        #[cfg(unix)]
        if let Some(registry) = &self.registry {
            let events = registry
                .lock()
                .map_err(|_| Error::Invalid("fleet owner closed"))?
                .poll()?;
            for event in events {
                changed |= self.accept_catalog(event);
            }
        }
        Ok(changed)
    }
    #[cfg(any(unix, test))]
    fn accept_catalog(&mut self, event: herdr_client::tmux_daemon::FleetCatalogEvent) -> bool {
        if self
            .labels
            .get(&event.route_id)
            .is_none_or(|v| v.1 != event.incarnation)
        {
            return false;
        }
        match event.result {
            Ok(catalog) => {
                self.recovery.success(&event.route_id);
                let recovered = self.failed.remove(&event.route_id);
                if self.catalogs.get(&event.route_id) == Some(&catalog) {
                    return recovered;
                }
                self.catalogs.insert(event.route_id, catalog);
                true
            }
            Err(error) => {
                self.recovery
                    .failed(&event.route_id, event.incarnation, &error, Instant::now());
                self.failed.insert(event.route_id)
            }
        }
    }
    pub(super) fn agent_group(&self, machine: &str) -> Option<bool> {
        self.agent_groups.get(machine).copied()
    }
    pub(super) fn project(
        &mut self,
        state: &mut State,
        selected: &str,
        identity: Option<&CatalogIdentity>,
    ) -> Result<(), Error> {
        self.agent_groups.clear();
        let Some(fleet) = &mut state.fleet else {
            return Ok(());
        };
        let Some(current) = fleet.groups.first().cloned() else {
            return Ok(());
        };
        let mut groups = BTreeMap::from([(selected.to_owned(), current)]);
        for (id, (label, _)) in &self.labels {
            groups.insert(
                id.clone(),
                group(
                    id,
                    label,
                    self.catalogs.get(id),
                    self.failed.contains(id) || self.disconnected.contains(id),
                )?,
            );
        }
        let mut identities = Vec::new();
        for id in std::iter::once(selected).chain(self.labels.keys().map(String::as_str)) {
            let identity = if id == selected {
                identity
            } else {
                self.catalogs.get(id).map(|c| &c.identity)
            };
            identities.push(FleetEnvironmentRoute {
                id,
                environment_id: identity.and_then(|i| i.environment_id.as_deref()),
                generation: identity.map(|i| i.instance_id.as_str()),
                ready: groups
                    .get(id)
                    .is_some_and(|g| g.state == fleet::Phase::Ready),
            });
        }
        let joined = group_fleet_environments(&identities, selected, &BTreeMap::new());
        let previous = std::mem::take(&mut self.selections);
        let previous_controls = std::mem::take(&mut self.controls);
        self.conflict = false;
        fleet.omitted_groups = joined.len().saturating_sub(64) as u64;
        fleet.groups.clear();
        let mut session_budget = 512usize;
        let mut server_budget = 128usize;
        for joined in joined.into_iter().take(64) {
            let Some(mut group) = groups.remove(joined.primary_route_id) else {
                continue;
            };
            group.conflict = joined.conflict;
            self.agent_groups.insert(group.id.clone(), !group.conflict);
            self.conflict |= group.id == selected && group.conflict;
            if group.conflict {
                group.collapse_action = None;
                for server in &mut group.servers {
                    server.selection = None;
                }
                for session in &mut group.sessions {
                    session.selection = None;
                    session.favorite_action = None;
                }
            }
            let server_limit = group.servers.len().min(server_budget);
            group.omitted_servers += (group.servers.len() - server_limit) as u64;
            group.servers.truncate(server_limit);
            server_budget -= server_limit;
            let old_len = group.sessions.len();
            group.sessions.retain(|s| {
                s.server_id
                    .as_ref()
                    .is_none_or(|id| group.servers.iter().any(|server| &server.id == id))
            });
            group.sessions.truncate(session_budget);
            group.omitted_sessions += (old_len - group.sessions.len()) as u64;
            session_budget -= group.sessions.len();
            if group.id != selected
                && !group.conflict
                && group.state == fleet::Phase::Ready
                && let Some((_, incarnation)) = self.labels.get(&group.id)
            {
                for server in &mut group.servers {
                    let Some(generation) = &server.generation else {
                        continue;
                    };
                    if server.state != fleet::ServerPhase::Online {
                        continue;
                    }
                    let selection = Selection {
                        machine: group.id.clone(),
                        incarnation: *incarnation,
                        target: CatalogTarget::Server(ServerScope {
                            server_id: server.id.clone(),
                            generation: generation.clone(),
                        }),
                    };
                    let token = previous
                        .iter()
                        .find(|(_, old)| **old == selection)
                        .map(|(token, _)| token.clone())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    server.selection = Some(token.clone());
                    self.selections.insert(token, selection);
                }
                for session in &mut group.sessions {
                    let selection = Selection {
                        machine: group.id.clone(),
                        incarnation: *incarnation,
                        target: CatalogTarget::Session(session.id.clone()),
                    };
                    let token = previous
                        .iter()
                        .find(|(_, old)| **old == selection)
                        .map(|(token, _)| token.clone())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    session.selection = Some(token.clone());
                    self.selections.insert(token, selection);
                }
            }
            if group.id != selected
                && !group.conflict
                && let Some((_, incarnation)) = self.labels.get(&group.id)
            {
                let retry = group.state == fleet::Phase::Disconnected;
                if retry || group.id != "local" {
                    let control = Control {
                        machine: group.id.clone(),
                        incarnation: *incarnation,
                        retry,
                        selected: false,
                    };
                    let token = previous_controls
                        .iter()
                        .find(|(_, old)| **old == control)
                        .map(|(token, _)| token.clone())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    if retry {
                        group.retry = Some(token.clone());
                    } else {
                        group.disconnect = Some(token.clone());
                    }
                    self.controls.insert(token, control);
                }
            }
            if group.id == selected
                && selected != "local"
                && !group.conflict
                && group.state == fleet::Phase::Ready
            {
                let control = Control {
                    machine: selected.into(),
                    incarnation: self.selected_epoch,
                    retry: false,
                    selected: true,
                };
                let token = previous_controls
                    .iter()
                    .find(|(_, old)| **old == control)
                    .map(|(token, _)| token.clone())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                group.disconnect = Some(token.clone());
                self.controls.insert(token, control);
            }
            fleet.groups.push(group);
        }
        Ok(())
    }
}
fn group(
    id: &str,
    label: &str,
    catalog: Option<&FleetCatalog>,
    failed: bool,
) -> Result<fleet::Group, Error> {
    let mut group = fleet::Group {
        id: id.into(),
        label: label.into(),
        state: if failed {
            fleet::Phase::Disconnected
        } else if catalog.is_some() {
            fleet::Phase::Ready
        } else {
            fleet::Phase::Connecting
        },
        collapsed: false,
        collapse_action: None,
        diagnostic: None,
        conflict: false,
        retry: None,
        disconnect: None,
        omitted_sessions: 0,
        sessions: vec![],
        servers: vec![],
        omitted_servers: 0,
    };
    let Some(catalog) = catalog else {
        return Ok(group);
    };
    group.omitted_servers = catalog.servers.len().saturating_sub(32) as u64;
    group.servers = catalog
        .servers
        .iter()
        .take(32)
        .map(|server| match server {
            ServerRegistration::Online { label, scope } => fleet::Server {
                id: scope.server_id.clone(),
                label: label.clone(),
                state: fleet::ServerPhase::Online,
                generation: Some(scope.generation.clone()),
                selection: None,
            },
            ServerRegistration::Offline { label, server_id } => fleet::Server {
                id: server_id.clone(),
                label: label.clone(),
                state: fleet::ServerPhase::Offline,
                generation: None,
                selection: None,
            },
        })
        .collect();
    for scoped in &catalog.sessions {
        for session in &scoped.sessions {
            if group.sessions.len() == 128 {
                group.omitted_sessions += 1;
                continue;
            }
            group.sessions.push(fleet::Session {
                id: catalog.identity.session_key(
                    id,
                    &scoped.scope,
                    &session.live_session_id,
                    false,
                )?,
                name: session.session_name.clone(),
                pane_count: session.pane_count.into(),
                server_id: Some(scoped.scope.server_id.clone()),
                session_id: Some(session.live_session_id.clone()),
                favorite: false,
                favorite_action: None,
                active: false,
                selection: None,
            });
        }
    }
    Ok(group)
}
impl Local {
    pub(super) fn fleet_control(&mut self, command: Command) -> Result<(), Error> {
        let (request, token, retry) = match command {
            Command::FleetRetry { request, retry } => (request, retry, true),
            Command::FleetDisconnect {
                request,
                disconnect,
            } => (request, disconnect, false),
            _ => return Ok(()),
        };
        let refreshing = matches!(self.stage, Some(Stage::Machines { change: None }));
        if request != self.state.request
            || !self.foreground
            || (self.stage.is_some() && !refreshing)
            || self.state.surface != Surface::Home
            || self.state.home_phase != HomePhase::Live
        {
            return Ok(());
        }
        let Some(control) = self
            .background_fleet
            .controls
            .get(&token)
            .filter(|c| c.retry == retry)
            .cloned()
        else {
            return Ok(());
        };
        if refreshing {
            self.cancel_registry();
            self.stage = None;
            self.submitted = false;
        }
        self.background_fleet.pending_control = Some((request, control));
        self.read_registry();
        self.publish()
    }
    pub(super) fn fleet_source_changed(&mut self) {
        self.background_fleet.selected_epoch = uuid::Uuid::new_v4();
        self.background_fleet.pending_control = None;
    }
    pub(super) fn fleet_cancel_control(&mut self) {
        self.background_fleet.pending_control = None;
    }
    /// Only called after a fresh authenticated registry result was reconciled.
    pub(super) fn fleet_apply_control(&mut self) -> Result<bool, Error> {
        let Some((request, control)) = self.background_fleet.pending_control.take() else {
            return Ok(false);
        };
        if request != self.state.request || !self.foreground {
            return Ok(false);
        }
        if control.selected {
            if !control.retry
                && control.machine == self.machine_id
                && control.incarnation == self.background_fleet.selected_epoch
            {
                self.disconnect_selected_fleet()?;
            }
            return Ok(false);
        }
        #[cfg(unix)]
        if let Some(registry) = &self.background_fleet.registry {
            let mut registry = registry
                .lock()
                .map_err(|_| Error::Invalid("fleet owner closed"))?;
            let changed = if control.retry {
                registry.retry(&control.machine, control.incarnation)?
            } else {
                registry.disconnect(&control.machine, control.incarnation)?
            };
            return Ok(changed.is_some());
        }
        #[cfg(not(unix))]
        let _ = control;
        Ok(false)
    }
    fn disconnect_selected_fleet(&mut self) -> Result<(), Error> {
        let Some(record) = self.local_record.clone() else {
            return Ok(());
        };
        let retired = self.machine_id.clone();
        self.switch_source(
            self.state.request,
            CatalogSource::Local(record),
            "local".into(),
            "Local".into(),
            None,
        )?;
        // switch_source retires the foreground SSH transport and registers its
        // route as background metadata. Stop that new queued source before the
        // actor can poll it, preserving explicit-disconnect intent on Home.
        #[cfg(unix)]
        if let Some(registry) = &self.background_fleet.registry {
            let mut registry = registry
                .lock()
                .map_err(|_| Error::Invalid("fleet owner closed"))?;
            let incarnation = registry
                .routes()
                .find(|(id, _, _)| *id == retired)
                .map(|(_, _, inc)| inc);
            if let Some(incarnation) = incarnation {
                registry.disconnect(&retired, incarnation)?;
            }
        }
        #[cfg(not(unix))]
        let _ = retired;
        self.fleet_resync()?;
        self.publish()
    }
    pub(super) fn fleet_reconcile(
        &mut self,
        registry: herdr_client::tmux_daemon::SavedMachineRegistry,
    ) -> Result<(), Error> {
        self.background_fleet
            .reconcile(self.local_record.as_ref(), registry, &self.machine_id)?;
        #[cfg(unix)]
        if let Some(handle) = &self.background_fleet.registry {
            self.sources.attach_fleet(handle.clone())?;
        }
        Ok(())
    }
    pub(super) fn fleet_tick(&mut self) -> Result<(), Error> {
        if self.background_fleet.poll()? {
            self.publish()?;
        }
        self.fleet_recovery_tick();
        Ok(())
    }
    pub(super) fn fleet_session(&mut self, request: u64, token: String) -> Result<(), Error> {
        let Some(selection) = self.background_fleet.selections.get(&token).cloned() else {
            if !self.background_fleet.conflict {
                self.open(request, token, None)?;
            }
            return Ok(());
        };
        if !matches!(selection.target, CatalogTarget::Session(_)) {
            return Ok(());
        }
        self.select_fleet_route(request, selection)
    }
    pub(super) fn fleet_server(&mut self, request: u64, token: String) -> Result<(), Error> {
        if request <= self.state.request
            || !self.foreground
            || (self.state.surface == Surface::Home && self.state.home_phase != HomePhase::Live)
            || self.stage.is_some()
        {
            return Ok(());
        }
        let Some(selection) = self.background_fleet.selections.get(&token).cloned() else {
            return self.select_server(request, token);
        };
        if !matches!(selection.target, CatalogTarget::Server(_)) {
            return Ok(());
        }
        self.select_fleet_route(request, selection)
    }
    fn select_fleet_route(&mut self, request: u64, selection: Selection) -> Result<(), Error> {
        if !self.foreground {
            return Ok(());
        }
        if selection.machine == "local" {
            self.switch_local(request)?;
        } else {
            self.select_history_machine(request, selection.machine.clone())?;
        }
        if self.state.request == request && self.stage.is_some() {
            self.background_fleet.pending = Some((request, selection.machine, selection.target));
        }
        Ok(())
    }
    pub(super) fn fleet_open_catalog(&mut self) -> Result<bool, Error> {
        self.background_fleet.project(
            &mut self.state.clone(),
            &self.machine_id,
            self.catalog_identity.as_ref(),
        )?;
        let Some((request, machine, target)) = self.background_fleet.pending.take() else {
            return Ok(false);
        };
        if request != self.state.request || machine != self.machine_id {
            return Ok(false);
        }
        if !self.background_fleet.allows_current() {
            self.unavailable("Fleet identity conflict — verify the machine before selecting it")?;
            return Ok(true);
        }
        let key = match target {
            CatalogTarget::Agent { scope, selection } => {
                if !self.open_observed_agent(request, scope, *selection)? {
                    self.unavailable("Agent session or machine changed — select the agent again")?;
                }
                return Ok(true);
            }
            CatalogTarget::Session(key) => key,
            CatalogTarget::Server(scope) => {
                let server = self
                    .state
                    .fleet
                    .as_ref()
                    .and_then(|fleet| fleet.groups.iter().find(|g| g.id == machine))
                    .and_then(|group| {
                        group.servers.iter().find(|server| {
                            server.id == scope.server_id
                                && server.generation.as_ref() == Some(&scope.generation)
                                && server.state == fleet::ServerPhase::Online
                        })
                    })
                    .cloned();
                if let Some(server) = server {
                    self.accept_server(server)?;
                } else {
                    self.unavailable("Fleet server generation changed — select the server again")?;
                }
                return Ok(true);
            }
        };
        let Some(identity) = &self.catalog_identity else {
            return Ok(false);
        };
        let token = self.targets.iter().find_map(|(token, target)| {
            (identity
                .session_key(&machine, &target.scope, &target.live, false)
                .ok()
                .as_deref()
                == Some(&key))
            .then(|| token.clone())
        });
        if let Some(token) = token {
            self.open(request, token, None)?;
        } else {
            self.unavailable("Fleet session changed or disappeared — refresh its catalog")?;
        }
        Ok(true)
    }
}

#[cfg(test)]
#[path = "browser_native_local_fleet_tests.rs"]
mod tests;
