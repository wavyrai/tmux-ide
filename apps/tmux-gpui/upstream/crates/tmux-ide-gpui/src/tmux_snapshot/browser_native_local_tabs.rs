//! Retained tabs store exact catalog identities, never connection capabilities.
use super::*;
use crate::tmux_snapshot::session_tabs::{Outcome, Publication, Result as Reply, Row};
use herdr_client::tmux_daemon::CatalogIdentity;
#[derive(Clone, PartialEq, Eq)]
pub(in crate::tmux_snapshot) struct Target {
    key: String,
    machine: String,
    identity: CatalogIdentity,
    scope: ServerScope,
    live: String,
    label: String,
    host: String,
    server: String,
}
#[path = "browser_native_local_tab_activity.rs"]
mod activity;
struct Tab {
    id: String,
    target: Target,
    activity: activity::Badge,
}
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Tabs {
    current: Vec<Target>,
    rows: Vec<Tab>,
    active: Option<String>,
    pending: Option<(u64, Target)>,
    publication: Option<Publication>,
    revision: u64,
    highest: u64,
}
fn display(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(160).collect()
}
fn same(a: &Target, b: &Target) -> bool {
    a.key == b.key
        && a.machine == b.machine
        && a.identity == b.identity
        && a.scope == b.scope
        && a.live == b.live
}
impl Tabs {
    pub(in crate::tmux_snapshot) fn advance(&mut self, from: u64, request: u64) {
        if let Some((old, _)) = &mut self.pending
            && *old == from
            && request > from
        {
            *old = request;
            self.publication = None;
        }
    }
    pub(super) fn cancel(&mut self) {
        self.active = None;
        for tab in &mut self.rows {
            tab.activity.unavailable();
        }
        self.pending = None;
        self.publication = None;
    }
    pub(in crate::tmux_snapshot) fn take_transition(
        &mut self,
        request: u64,
        machine: &str,
    ) -> Option<(u64, Target)> {
        if self
            .pending
            .as_ref()
            .is_some_and(|(r, t)| *r == request && t.machine == machine)
        {
            self.pending.take()
        } else {
            None
        }
    }
    pub(in crate::tmux_snapshot) fn restore_transition(&mut self, pending: Option<(u64, Target)>) {
        self.pending = pending;
        self.publication = None;
    }
    fn accept(&mut self, request: u64, target: Target) {
        if self.pending.is_none()
            && self
                .rows
                .iter()
                .any(|r| self.active.as_ref() == Some(&r.id) && r.target == target)
        {
            return;
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|(r, t)| *r != request || !same(t, &target))
        {
            return;
        }
        self.pending = None;
        if let Some(row) = self.rows.iter_mut().find(|row| same(&row.target, &target)) {
            row.target = target;
            row.activity.unread = false;
            self.active = Some(row.id.clone());
        } else {
            if self.rows.len() == 8 {
                let index = self
                    .rows
                    .iter()
                    .position(|row| Some(&row.id) != self.active.as_ref())
                    .unwrap_or(0);
                self.rows.remove(index);
            }
            let id = uuid::Uuid::new_v4().to_string();
            self.active = Some(id.clone());
            self.rows.push(Tab {
                id,
                target,
                activity: Default::default(),
            });
        }
        self.publication = None;
    }
    fn publish(
        &mut self,
        request: u64,
        foreground: bool,
        targets: &[Target],
    ) -> Option<Publication> {
        if !foreground {
            self.publication = None;
            return None;
        }
        if self
            .publication
            .as_ref()
            .is_none_or(|p| p.request != request)
        {
            if self.revision >= MAX {
                return None;
            }
            self.revision += 1;
            let rows: Vec<_> = self
                .rows
                .iter()
                .map(|tab| Row {
                    id: tab.id.clone(),
                    label: display(&tab.target.label),
                    host_label: display(&tab.target.host),
                    server_label: Some(display(&tab.target.server)),
                    available: false,
                    unread: tab.activity.unread,
                    activity: tab.activity.activity,
                    activate: uuid::Uuid::new_v4().to_string(),
                    close: uuid::Uuid::new_v4().to_string(),
                })
                .collect();
            let index = self
                .active
                .as_ref()
                .and_then(|id| rows.iter().position(|r| &r.id == id));
            self.publication = Some(Publication {
                request,
                revision: self.revision,
                active: self.active.clone(),
                pending: self.pending.as_ref().and_then(|(_, t)| {
                    self.rows
                        .iter()
                        .find(|r| same(&r.target, t))
                        .map(|r| r.id.clone())
                }),
                next: (!rows.is_empty()).then(|| {
                    rows[index.map_or(0, |i| (i + 1) % rows.len())]
                        .activate
                        .clone()
                }),
                previous: (!rows.is_empty()).then(|| {
                    rows[index.map_or(rows.len() - 1, |i| (i + rows.len() - 1) % rows.len())]
                        .activate
                        .clone()
                }),
                close_active: index.map(|i| rows[i].close.clone()),
                rows,
            });
        }
        let p = self.publication.as_mut()?;
        for (row, tab) in p.rows.iter_mut().zip(&self.rows) {
            let fresh = targets.iter().find(|t| same(t, &tab.target));
            row.available = fresh.is_some();
            row.unread = tab.activity.unread;
            row.activity = tab.activity.activity;
            row.label = display(fresh.map_or(&tab.target.label, |t| &t.label));
        }
        Some(p.clone())
    }
    fn admit(
        &mut self,
        command: &Reply,
        current: u64,
        foreground: bool,
    ) -> Option<(Target, bool, bool)> {
        if !command.valid() || command.request <= current || command.request <= self.highest {
            return None;
        }
        self.highest = command.request;
        let p = self.publication.as_ref()?;
        if !foreground
            || command.from_request != current
            || p.request != current
            || p.revision != command.revision
        {
            return None;
        }
        let (index, row) = p
            .rows
            .iter()
            .enumerate()
            .find(|(_, r)| r.activate == command.action || r.close == command.action)?;
        let close = row.close == command.action;
        let home = self.active.as_ref() == Some(&row.id)
            || self
                .pending
                .as_ref()
                .is_some_and(|(_, t)| same(t, &self.rows[index].target));
        Some((self.rows[index].target.clone(), close, home))
    }
}
impl Local {
    fn tab_targets(&self) -> Vec<Target> {
        if !self.background_fleet.allows_current() {
            return Vec::new();
        }
        let mut result: Vec<_> = self
            .navigation
            .tabs
            .current
            .iter()
            .filter(|t| {
                t.machine == self.machine_id && Some(&t.identity) == self.catalog_identity.as_ref()
            })
            .cloned()
            .collect();
        for (machine, host, catalog) in self.background_fleet.tab_catalogs() {
            for sessions in &catalog.sessions {
                for session in &sessions.sessions {
                    if let Ok(key) = catalog.identity.session_key(
                        machine,
                        &sessions.scope,
                        &session.live_session_id,
                        false,
                    ) {
                        result.push(Target {
                            key,
                            machine: machine.into(),
                            identity: catalog.identity.clone(),
                            scope: sessions.scope.clone(),
                            live: session.live_session_id.clone(),
                            label: session.session_name.clone(),
                            host: host.into(),
                            server: catalog
                                .servers
                                .iter()
                                .find_map(|s| match s {
                                    ServerRegistration::Online { label, scope }
                                        if scope == &sessions.scope =>
                                    {
                                        Some(label.clone())
                                    }
                                    _ => None,
                                })
                                .unwrap_or_else(|| sessions.scope.server_id.clone()),
                        });
                    }
                }
            }
        }
        result
    }
    pub(in crate::tmux_snapshot) fn seed_tabs(
        &mut self,
        catalog: &herdr_client::tmux_daemon::FleetCatalog,
    ) {
        self.navigation.tabs.current.clear();
        for sessions in &catalog.sessions {
            for session in &sessions.sessions {
                if let Ok(key) = catalog.identity.session_key(
                    &self.machine_id,
                    &sessions.scope,
                    &session.live_session_id,
                    false,
                ) {
                    self.navigation.tabs.current.push(Target {
                        key,
                        machine: self.machine_id.clone(),
                        identity: catalog.identity.clone(),
                        scope: sessions.scope.clone(),
                        live: session.live_session_id.clone(),
                        label: session.session_name.clone(),
                        host: self.machine_label.clone(),
                        server: catalog
                            .servers
                            .iter()
                            .find_map(|s| match s {
                                ServerRegistration::Online { label, scope }
                                    if scope == &sessions.scope =>
                                {
                                    Some(label.clone())
                                }
                                _ => None,
                            })
                            .unwrap_or_else(|| sessions.scope.server_id.clone()),
                    });
                }
            }
        }
    }
    pub(in crate::tmux_snapshot) fn publish_tabs(&mut self, state: &mut State) {
        let targets = self.tab_targets();
        for tab in &mut self.navigation.tabs.rows {
            let observation =
                if self.foreground && targets.iter().any(|target| same(target, &tab.target)) {
                    self.agents.tab_observation(
                        &tab.target.machine,
                        &tab.target.identity,
                        &tab.target.scope,
                        &tab.target.live,
                    )
                } else {
                    agents::TabObservation::Unavailable
                };
            match observation {
                agents::TabObservation::Pending => {}
                agents::TabObservation::Unavailable => tab.activity.unavailable(),
                agents::TabObservation::Ready(epoch, value) => tab.activity.observe_once(
                    epoch,
                    &value.agents,
                    self.navigation.tabs.active.as_ref() == Some(&tab.id),
                ),
            }
        }
        state.session_tabs = self
            .navigation
            .tabs
            .publish(state.request, self.foreground, &targets);
    }
    pub(in crate::tmux_snapshot) fn accept_tab(&mut self) {
        let Some(route) = &self.active else {
            return;
        };
        let target = self.tab_targets().into_iter().find(|t| {
            t.machine == self.machine_id
                && t.scope == route.target.scope
                && t.live == route.target.live
        });
        if let Some(target) = target {
            self.navigation.tabs.accept(route.request, target);
        }
    }
    pub(in crate::tmux_snapshot) fn navigate_tab(
        &mut self,
        mut command: Reply,
    ) -> Result<(), Error> {
        let admitted = self
            .navigation
            .tabs
            .admit(&command, self.state.request, self.foreground);
        if let Some((target, close, home)) = admitted {
            if close {
                self.navigation
                    .tabs
                    .rows
                    .retain(|r| !same(&r.target, &target));
                self.navigation.tabs.publication = None;
                if home {
                    self.home(command.request)?;
                } else {
                    command.outcome = Outcome::Closed;
                    self.state.session_tab_result = Some(command);
                }
                return self.publish();
            }
            if self.tab_targets().iter().any(|t| same(t, &target)) {
                // Even same-machine activation revalidates registry and catalog.
                if target.machine == "local" {
                    self.switch_local(command.request)?;
                } else {
                    self.select_history_machine(command.request, target.machine.clone())?;
                }
                if self.state.request == command.request && self.stage.is_some() {
                    self.navigation.tabs.pending = Some((command.request, target));
                    self.navigation.tabs.publication = None;
                    self.state.session_tab_result = None;
                    return self.publish();
                }
            }
        }
        command.outcome = Outcome::Rejected;
        self.state.session_tab_result = Some(command);
        self.publish()
    }
    pub(in crate::tmux_snapshot) fn tab_catalog(&mut self) -> Result<bool, Error> {
        self.background_fleet.project(
            &mut self.state.clone(),
            &self.machine_id,
            self.catalog_identity.as_ref(),
        )?;
        let Some((request, target)) = self.navigation.tabs.pending.clone() else {
            return Ok(false);
        };
        if request != self.state.request || target.machine != self.machine_id {
            return Ok(false);
        }
        if !self.tab_targets().iter().any(|fresh| same(fresh, &target)) {
            self.unavailable("Tab session identity changed or disappeared — select a session")?;
            return Ok(true);
        }
        let token = self
            .targets
            .iter()
            .find(|(_, t)| t.scope == target.scope && t.live == target.live)
            .map(|(token, _)| token.clone());
        if let Some(token) = token {
            self.open(request, token, None)?;
            self.navigation.tabs.pending = Some((request, target));
        }
        Ok(true)
    }
}
#[cfg(test)]
#[path = "browser_native_local_tabs_tests.rs"]
mod tests;
