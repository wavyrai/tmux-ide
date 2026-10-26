//! Bounded fleet agent observation. One pool survives navigation and retains
//! canceled workers until retirement; terminal input never uses this lane.
use super::*;
use herdr_client::tmux_daemon::{
    AgentObservation, AgentObservationPool, AgentObservationRequest, AgentSelection,
    CatalogIdentity, FleetCatalog, MAX_AGENT_OBSERVATION_SESSIONS, ObservedAgent,
};
#[path = "browser_native_local_agent_picker.rs"]
mod picker;
#[path = "browser_native_local_agent_projection.rs"]
mod projection;
#[path = "browser_native_local_agent_recovery.rs"]
mod recovery;
#[path = "browser_native_local_workspace_agents.rs"]
mod workspace_fleet;
#[derive(Clone, PartialEq, Eq)]
struct Context {
    machine: String,
    machine_label: String,
    incarnation: Option<uuid::Uuid>,
    readable: bool,
    key: String,
    catalog_identity: CatalogIdentity,
    scope: ServerScope,
    live: String,
    workspace: Option<String>,
    session_label: String,
    server_label: Option<String>,
}
enum Observed {
    Loading,
    Failed,
    Ready(AgentObservation),
}
pub(super) enum TabObservation<'a> {
    Pending,
    Unavailable,
    Ready(uuid::Uuid, &'a AgentObservation),
}
struct Slot {
    context: Context,
    observed: Observed,
}
#[derive(Default)]
pub(super) struct Gate {
    pool: AgentObservationPool,
    picker: picker::Picker,
    workspace_scope: Option<(u64, u64)>,
    next_workspace_scope: u64,
    workspace_attempt: u64,
    workspace_seeded: bool,
    catalog_unavailable: bool,
    machine_filter: Option<String>,
    extra_sessions: usize,
    control_first: Option<u64>,
    retry_first: Option<u64>,
    load_first: Option<u64>,
    catalog: Vec<Context>,
    catalog_total: usize,
    sources: BTreeMap<String, CatalogSource>,
    incomplete_routes: usize,
    contexts: Vec<Context>,
    slots: Vec<Slot>,
    epoch: Option<uuid::Uuid>,
    revision: u64,
    published: BTreeMap<String, u64>,
    total: usize,
    workspace: bool,
    enabled: bool,
    cycle: bool,
    due: Option<Instant>,
}
impl Gate {
    pub(super) fn tab_observation(
        &self,
        machine: &str,
        identity: &CatalogIdentity,
        scope: &ServerScope,
        live: &str,
    ) -> TabObservation<'_> {
        match self
            .slots
            .iter()
            .find(|s| {
                s.context.machine == machine
                    && &s.context.catalog_identity == identity
                    && &s.context.scope == scope
                    && s.context.live == live
            })
            .map(|s| &s.observed)
        {
            Some(Observed::Loading) => TabObservation::Pending,
            Some(Observed::Ready(value)) => {
                self.epoch.map_or(TabObservation::Unavailable, |epoch| {
                    TabObservation::Ready(epoch, value)
                })
            }
            _ => TabObservation::Unavailable,
        }
    }
    pub(super) fn cancel(&mut self) {
        self.pool.cancel();
        self.picker.cancel();
        self.workspace_scope = None;
        self.workspace_seeded = false;
        self.catalog_unavailable = false;
        self.machine_filter = None;
        self.extra_sessions = 0;
        self.catalog.clear();
        self.sources.clear();
        self.catalog_total = 0;
        self.contexts.clear();
        self.slots.clear();
        self.published.clear();
        self.epoch = None;
        self.clear_controls();
        self.enabled = false;
        self.cycle = false;
        self.due = None;
    }
    fn includes_machine(&self, machine: &str) -> bool {
        self.machine_filter
            .as_deref()
            .is_none_or(|id| id == machine)
    }
    pub(super) fn publish_filter(&self, state: &mut State) {
        state.home_agent_recovery = None;
        state.home_agent_filter = None;
        if self.enabled
            && state.surface == Surface::Home
            && let Some(roster) = &state.home_agents
            && let Some(fleet) = &state.fleet
            && self
                .machine_filter
                .as_ref()
                .is_none_or(|id| fleet.groups.iter().any(|g| &g.id == id))
        {
            state.home_agent_recovery = Some(self.recovery_capability(roster.revision));
            state.home_agent_filter =
                Some(crate::tmux_snapshot::home::machine_filter::Capability {
                    revision: roster.revision,
                    machine_id: self.machine_filter.clone(),
                });
        }
    }
    pub(super) fn busy(&self) -> bool {
        self.pool.busy()
    }
    pub(super) fn wait(&self) -> Option<Duration> {
        self.due
            .map(|due| due.saturating_duration_since(Instant::now()))
    }
    pub(super) fn seed(&mut self, catalog: &FleetCatalog, machine: &str, label: &str) {
        self.catalog_total = catalog.sessions.iter().map(|g| g.sessions.len()).sum();
        self.catalog = contexts(
            catalog,
            machine,
            label,
            None,
            true,
            MAX_AGENT_OBSERVATION_SESSIONS,
        );
    }
    fn configure(
        &mut self,
        contexts: Vec<Context>,
        total: usize,
        workspace: bool,
        incomplete_routes: usize,
        now: Instant,
    ) -> bool {
        let contexts: Vec<_> = contexts.into_iter().take(self.session_limit()).collect();
        if self.enabled
            && self.contexts == contexts
            && self.total == total
            && self.workspace == workspace
            && self.incomplete_routes == incomplete_routes
        {
            return false;
        }
        self.pool.cancel();
        self.contexts = contexts;
        self.total = total;
        self.workspace = workspace;
        self.incomplete_routes = incomplete_routes;
        self.enabled = true;
        self.prepare_slots();
        self.published.clear();
        self.epoch = None;
        self.clear_controls();
        self.cycle = false;
        self.due = Some(now);
        true
    }
    fn prepare_slots(&mut self) {
        self.slots = self
            .contexts
            .iter()
            .cloned()
            .map(|context| Slot {
                observed: if context.workspace.is_some() && context.readable {
                    Observed::Loading
                } else {
                    Observed::Failed
                },
                context,
            })
            .collect();
    }
    fn suspend(&mut self) -> bool {
        if !self.enabled {
            return false;
        }
        self.pool.cancel();
        self.enabled = false;
        self.slots.clear();
        self.published.clear();
        self.epoch = None;
        self.clear_controls();
        self.cycle = false;
        self.due = None;
        true
    }
    fn poll(&mut self, eligible: bool, now: Instant) -> bool {
        let mut changed = false;
        for event in self.pool.poll() {
            if self.epoch == Some(event.epoch)
                && let Some(slot) = self
                    .slots
                    .iter_mut()
                    .find(|slot| slot.context.key == event.key)
            {
                slot.observed = event.result.map_or(Observed::Failed, Observed::Ready);
                changed = true;
            }
        }
        if self.cycle && !self.pool.busy() {
            self.cycle = false;
            self.due = self
                .contexts
                .iter()
                .any(|c| c.workspace.is_some() && c.readable)
                .then_some(now + Duration::from_secs(5));
        }
        if eligible && !self.pool.busy() && self.due.is_some_and(|due| now >= due) {
            self.published.clear();
            self.prepare_slots();
            let requests = self
                .contexts
                .iter()
                .filter_map(|context| {
                    if !context.readable {
                        return None;
                    }
                    Some(AgentObservationRequest {
                        key: context.key.clone(),
                        catalog_identity: context.catalog_identity.clone(),
                        source: self.sources.get(&context.machine)?.clone(),
                        scope: context.scope.clone(),
                        live_session_id: context.live.clone(),
                        workspace_name: context.workspace.clone()?,
                    })
                })
                .collect();
            match self.pool.replace(requests) {
                Ok(epoch) => self.epoch = Some(epoch),
                Err(_) => {
                    self.published.clear();
                    self.epoch = None;
                    self.clear_controls();
                    for slot in &mut self.slots {
                        slot.observed = Observed::Failed;
                    }
                }
            }
            self.cycle = true;
            self.due = None;
            changed = true;
        }
        changed
    }
    fn resolve(&self, key: &str, revision: u64) -> Option<(Context, ObservedAgent)> {
        if !self.enabled
            || revision > self.revision
            || self
                .published
                .get(key)
                .is_none_or(|first| revision < *first)
        {
            return None;
        }
        for slot in &self.slots {
            if let Observed::Ready(result) = &slot.observed {
                for agent in &result.agents {
                    if self.row_key(&slot.context, agent) == key && available(agent) {
                        return Some((slot.context.clone(), agent.clone()));
                    }
                }
            }
        }
        None
    }
    fn row_key(&self, context: &Context, agent: &ObservedAgent) -> String {
        format!(
            "{}\0{}\0{}",
            self.epoch.map_or_else(String::new, |e| e.to_string()),
            context.key,
            agent.id
        )
    }
}
fn contexts(
    catalog: &FleetCatalog,
    machine: &str,
    label: &str,
    incarnation: Option<uuid::Uuid>,
    readable: bool,
    limit: usize,
) -> Vec<Context> {
    catalog
        .sessions
        .iter()
        .flat_map(|group| {
            group.sessions.iter().map(|session| Context {
                machine: machine.into(),
                machine_label: label.into(),
                incarnation,
                readable,
                catalog_identity: catalog.identity.clone(),
                key: format!(
                    "{}:{}:{}:{}:{}",
                    machine,
                    incarnation.map_or_else(String::new, |i| i.to_string()),
                    group.scope.server_id,
                    group.scope.generation,
                    session.live_session_id
                ),
                scope: group.scope.clone(),
                live: session.live_session_id.clone(),
                workspace: session.workspace_name.clone(),
                session_label: session.session_name.clone(),
                server_label: catalog.servers.iter().find_map(|server| match server {
                    ServerRegistration::Online { scope, label } if scope == &group.scope => {
                        Some(label.clone())
                    }
                    _ => None,
                }),
            })
        })
        .take(limit.min(MAX_AGENT_OBSERVATION_SESSIONS))
        .collect()
}
fn available(agent: &ObservedAgent) -> bool {
    agent.pane_id.is_some()
        && (agent.native_identity.is_some() || agent.interaction_endpoint.is_some())
}
impl Local {
    pub(super) fn filter_agents(
        &mut self,
        request: u64,
        revision: u64,
        machine: Option<String>,
    ) -> Result<(), Error> {
        if !self.foreground
            || self.state.surface != Surface::Home
            || self.state.home_phase != HomePhase::Live
            || self.state.request != request
            || !self.agents.control_current(revision)
            || self.state.home_agents.is_none()
            || machine
                .as_ref()
                .is_some_and(|id| self.background_fleet.agent_group(id).is_none())
        {
            return Ok(());
        }
        self.agents.machine_filter = machine;
        self.agents.suspend();
        self.state.home_agents = None;
        self.agent_tick()
    }
    pub(super) fn agent_tick(&mut self) -> Result<(), Error> {
        let visible = self.foreground
            && self.background_fleet.allows_current()
            && ((self.state.surface == Surface::Home && self.state.home_phase == HomePhase::Live)
                || (self.state.surface == Surface::Workspace && self.active.is_some()));
        if !visible {
            let changed = self.agents.suspend() | self.agents.picker.cancel();
            // Retired reads still occupy slots while hidden; polling only reaps them.
            let _ = self.agents.pool.poll();
            if changed {
                self.state.home_agents = None;
                self.state.workspace_agents = None;
                self.state.workspace_fleet_agents = None;
                self.agents.workspace_scope = None;
                self.state.palette_agents = None;
                self.state.attention_agents = None;
                self.publish()?;
            }
            return Ok(());
        }
        let picking = self.agents.picker.active(self.state.request);
        if picking && self.agents.picker.failed {
            if self.agents.picker.dirty {
                self.state.home_agents = None;
                self.state.workspace_agents = None;
                self.state.workspace_fleet_agents = None;
                self.agents.workspace_scope = None;
                self.agents.picker_publication(&mut self.state);
                self.publish()?;
            }
            return Ok(());
        }
        let workspace = self.state.surface == Surface::Workspace;
        if workspace && !self.agents.workspace_seeded {
            self.agents.workspace_seeded = true;
            if let Some(snapshot) = self
                .sources
                .catalog_snapshot()?
                .filter(|s| self.catalog_identity.as_ref() == Some(&s.identity))
            {
                self.picker_catalog(&snapshot)?;
            } else {
                self.agents.catalog_unavailable = true;
            }
        }
        if self
            .agents
            .machine_filter
            .as_ref()
            .is_some_and(|id| self.background_fleet.agent_group(id).is_none())
        {
            self.agents.machine_filter = None;
            self.agents.suspend();
        }
        let includes_current =
            picking || workspace || self.agents.includes_machine(&self.machine_id);
        let mut sources =
            BTreeMap::from([(self.machine_id.clone(), self.sources.observation_source()?)]);
        let mut total = if includes_current {
            self.agents.catalog_total
        } else {
            0
        };
        let mut incomplete = usize::from(self.agents.catalog_unavailable);
        let mut view_contexts = if let Some(route) = self.active.as_ref().filter(|_| workspace) {
            let Some(identity) = self.catalog_identity.clone() else {
                return Ok(());
            };
            vec![Context {
                machine: self.machine_id.clone(),
                machine_label: self.machine_label.clone(),
                incarnation: None,
                readable: true,
                catalog_identity: identity,
                key: format!(
                    "{}:{}:{}",
                    route.target.scope.server_id, route.target.scope.generation, route.target.live
                ),
                scope: route.target.scope.clone(),
                live: route.target.live.clone(),
                workspace: Some(route.workspace.clone()),
                session_label: self
                    .agents
                    .catalog
                    .iter()
                    .find(|c| c.scope == route.target.scope && c.live == route.target.live)
                    .map_or_else(|| route.workspace.clone(), |c| c.session_label.clone()),
                server_label: self
                    .agents
                    .catalog
                    .iter()
                    .find(|c| c.scope == route.target.scope && c.live == route.target.live)
                    .and_then(|c| c.server_label.clone()),
            }]
        } else if includes_current {
            self.agents
                .catalog
                .iter()
                .take(self.agents.session_limit())
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        if workspace {
            let active_in_catalog = view_contexts.first().is_some_and(|active| {
                self.agents
                    .catalog
                    .iter()
                    .any(|c| c.scope == active.scope && c.live == active.live)
            });
            if !active_in_catalog {
                total += view_contexts.len();
            }
            let remaining = self
                .agents
                .session_limit()
                .saturating_sub(view_contexts.len());
            let extra: Vec<_> = self
                .agents
                .catalog
                .iter()
                .filter(|c| {
                    !view_contexts
                        .iter()
                        .any(|active| active.scope == c.scope && active.live == c.live)
                })
                .take(remaining)
                .cloned()
                .collect();
            view_contexts.extend(extra);
        }
        {
            let mut seen = std::collections::BTreeSet::new();
            if let Some(identity) = self.catalog_identity.as_ref().filter(|_| includes_current) {
                seen.insert(identity.group_key(&self.machine_id).to_owned());
            }
            let mut routes = self.background_fleet.agent_routes()?;
            routes.sort_by_key(|route| route.source.is_none());
            for route in routes {
                if !workspace && !picking && !self.agents.includes_machine(route.machine) {
                    continue;
                }
                match self.background_fleet.agent_group(route.machine) {
                    None => continue, // Alias or omitted group; use the projected primary.
                    Some(false) => {
                        incomplete += 1;
                        continue;
                    }
                    Some(true) => {}
                }
                let Some(catalog) = route.catalog else {
                    incomplete += 1;
                    continue;
                };
                if !seen.insert(catalog.identity.group_key(route.machine).to_owned()) {
                    continue;
                }
                let readable = route.source.is_some();
                if !readable {
                    incomplete += 1;
                }
                total += catalog
                    .sessions
                    .iter()
                    .map(|g| g.sessions.len())
                    .sum::<usize>();
                if view_contexts.len() < self.agents.session_limit() {
                    view_contexts.extend(
                        contexts(
                            catalog,
                            route.machine,
                            route.label,
                            Some(route.incarnation),
                            readable,
                            self.agents.session_limit() - view_contexts.len(),
                        )
                        .into_iter()
                        .take(self.agents.session_limit() - view_contexts.len()),
                    );
                }
                if let Some(source) = route.source {
                    sources.insert(route.machine.into(), source);
                }
            }
        }
        self.agents.sources = sources;
        let now = Instant::now();
        let mut changed = self
            .agents
            .configure(view_contexts, total, workspace, incomplete, now);
        changed |= self.agents.poll(self.stage.is_none(), now);
        changed |= self.agents.picker.dirty;
        if changed && picking {
            self.state.home_agents = None;
            self.state.workspace_agents = None;
            self.state.workspace_fleet_agents = None;
            self.agents.workspace_scope = None;
            self.agents.picker_publication(&mut self.state);
            self.publish()?;
        } else if changed {
            self.agents.picker.dirty = false;
            self.state.palette_agents = None;
            self.state.attention_agents = None;
            let roster = self.agents.publication();
            if workspace {
                self.state.home_agents = None;
                self.publish_workspace_agents(roster);
            } else {
                self.state.workspace_agents = None;
                self.state.workspace_fleet_agents = None;
                self.agents.workspace_scope = None;
                self.state.home_agents = Some(roster);
            }
            self.publish()?;
        }
        Ok(())
    }
    pub(super) fn open_agent(&mut self, command: Command) -> Result<(), Error> {
        let (request, from_request, revision, key, session) = match command {
            Command::OpenAgent {
                request,
                from_request,
                roster_revision,
                key,
            } if self.state.surface == Surface::Home => {
                (request, from_request, roster_revision, key, None)
            }
            Command::OpenWorkspaceAgent {
                request,
                from_request,
                roster_revision,
                key,
                session_id,
            } if self.state.surface == Surface::Workspace => (
                request,
                from_request,
                roster_revision,
                key,
                Some(session_id),
            ),
            _ => return Ok(()),
        };
        if !self.foreground
            || from_request != self.state.request
            || request <= from_request
            || self.stage.is_some()
        {
            return Ok(());
        }
        let Some((context, agent)) = self.agents.resolve(&key, revision) else {
            return Ok(());
        };
        if session
            .as_ref()
            .is_some_and(|s| s != &context.live || self.state.selected_session.as_ref() != Some(s))
        {
            return Ok(());
        }
        let _ = self.open_agent_target(request, context, agent)?;
        Ok(())
    }
    fn open_agent_target(
        &mut self,
        request: u64,
        context: Context,
        agent: ObservedAgent,
    ) -> Result<bool, Error> {
        let selection = AgentSelection {
            catalog_identity: context.catalog_identity.clone(),
            live_session_id: context.live.clone(),
            workspace_name: context
                .workspace
                .clone()
                .ok_or(Error::Invalid("agent workspace missing"))?,
            agent,
        };
        if context.machine != self.machine_id {
            if let Some(incarnation) = context.incarnation {
                self.open_fleet_agent(
                    request,
                    context.machine,
                    incarnation,
                    context.scope,
                    selection,
                )?;
                return Ok(self.state.request == request);
            }
            return Ok(false);
        }
        self.open_observed_agent(request, context.scope, selection)
    }
}

#[cfg(test)]
#[path = "browser_native_local_agents_tests.rs"]
mod tests;
