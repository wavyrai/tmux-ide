//! Native Home catalog and one-shot creation. Only catalog tokens select scopes.
use super::*;
use herdr_client::tmux_daemon::{CreatedSession, Session};
impl Local {
    pub(super) fn receive_catalog(
        &mut self,
        snapshot: herdr_client::tmux_daemon::FleetCatalog,
        initial: bool,
    ) -> Result<(), Error> {
        self.seed_tabs(&snapshot);
        self.agents
            .seed(&snapshot, &self.machine_id, &self.machine_label);
        self.sources.seed_catalog(&snapshot)?;
        let previous = std::mem::take(&mut self.targets);
        self.state.sessions.clear();
        self.catalog_identity = Some(snapshot.identity);
        let servers = self.catalog_servers(snapshot.servers);
        if servers.is_empty() {
            self.local_creation.offer = None;
            if self.machine_id == "local"
                && self.local_record.is_some()
                && self.foreground
                && self.uncertain_create.is_none()
            {
                self.state.local_session_create = None;
                self.state.home_phase = HomePhase::Loading;
                self.state.status = "Checking local session creation".into();
                self.stage = Some(Stage::LocalProve);
                return self.publish();
            }
            return self.unavailable("No online tmux servers");
        }
        self.local_creation.offer = None;
        self.state.local_session_create = None;
        for group in snapshot.sessions {
            for session in group.sessions {
                let id = previous
                    .iter()
                    .find(|(_, target)| {
                        target.scope == group.scope && target.live == session.live_session_id
                    })
                    .map(|(id, _)| id.clone())
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                self.catalog_session(&id, &group.scope, &session)?;
                self.targets.insert(
                    id.clone(),
                    Target {
                        scope: group.scope.clone(),
                        live: session.live_session_id,
                    },
                );
                self.state.sessions.push(Choice {
                    id,
                    label: session.session_name,
                    pane_count: Some(u64::from(session.pane_count)),
                    window_id: None,
                    browser_icon: None,
                    window_label: None,
                });
            }
        }
        if self.state.selected_server.as_ref().is_some_and(|selected| {
            self.state
                .fleet
                .as_ref()
                .is_none_or(|fleet| !selected.valid(fleet))
        }) {
            self.state.selected_server = None;
        }
        self.state.home_phase = HomePhase::Live;
        self.state.session_catalog_complete = true;
        self.cache_catalog();
        self.state.status = "Sessions ready".into();
        self.creation_status();
        if !initial
            || (!self.tab_catalog()?
                && !self.fleet_open_catalog()?
                && !self.navigate_catalog()?
                && !self.reconnect_catalog()?)
        {
            self.publish()?;
            if initial && self.local_record.is_some() && self.selected_profile.is_none() {
                self.read_registry();
            }
        }
        Ok(())
    }

    pub(super) fn catalog_servers(&mut self, entries: Vec<ServerRegistration>) -> Vec<ServerScope> {
        let previous = self
            .state
            .fleet
            .as_ref()
            .and_then(|fleet| fleet.groups.first())
            .map(|group| group.servers.clone())
            .unwrap_or_default();
        let omitted_servers = entries.len().saturating_sub(32) as u64;
        let mut scopes = Vec::new();
        let servers = entries
            .into_iter()
            .take(32)
            .map(|entry| match entry {
                ServerRegistration::Online { label, scope } => {
                    scopes.push(scope.clone());
                    let selection = previous
                        .iter()
                        .find(|server| {
                            server.id == scope.server_id
                                && server.generation.as_ref() == Some(&scope.generation)
                        })
                        .and_then(|server| server.selection.clone())
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    fleet::Server {
                        id: scope.server_id,
                        label,
                        state: fleet::ServerPhase::Online,
                        generation: Some(scope.generation),
                        selection: Some(selection),
                    }
                }
                ServerRegistration::Offline { label, server_id } => fleet::Server {
                    id: server_id,
                    label,
                    state: fleet::ServerPhase::Offline,
                    generation: None,
                    selection: None,
                },
            })
            .collect();
        self.state.fleet = Some(fleet::Fleet {
            preferences: None,
            omitted_groups: 0,
            groups: vec![fleet::Group {
                id: self.machine_id.clone(),
                label: self.machine_label.clone(),
                state: fleet::Phase::Ready,
                collapsed: false,
                collapse_action: None,
                diagnostic: None,
                conflict: false,
                retry: None,
                disconnect: None,
                omitted_sessions: 0,
                sessions: Vec::new(),
                servers,
                omitted_servers,
            }],
        });
        scopes
    }
    pub(super) fn catalog_session(
        &mut self,
        token: &str,
        scope: &ServerScope,
        session: &Session,
    ) -> Result<(), Error> {
        let identity = self
            .catalog_identity
            .as_ref()
            .ok_or(Error::Invalid("native catalog identity missing"))?;
        let stable_key =
            identity.session_key(&self.machine_id, scope, &session.live_session_id, false)?;
        let Some(group) = self
            .state
            .fleet
            .as_mut()
            .and_then(|fleet| fleet.groups.first_mut())
        else {
            return Ok(());
        };
        if group.sessions.len() == 128 {
            group.omitted_sessions += 1;
            return Ok(());
        }
        group.sessions.push(fleet::Session {
            server_id: Some(scope.server_id.clone()),
            favorite: false,
            favorite_action: None,
            active: false,
            id: stable_key,
            name: session.session_name.clone(),
            pane_count: u64::from(session.pane_count),
            session_id: Some(session.live_session_id.clone()),
            selection: Some(token.into()),
        });
        Ok(())
    }
    pub(super) fn select_server(&mut self, request: u64, selection: String) -> Result<(), Error> {
        if !self.background_fleet.allows_current()
            || request <= self.state.request
            || !self.foreground
            || (self.state.surface == Surface::Home && self.state.home_phase != HomePhase::Live)
            || self.stage.is_some()
        {
            return Ok(());
        }
        let Some(server) = self
            .state
            .fleet
            .as_ref()
            .and_then(|fleet| fleet.server(&selection))
            .cloned()
        else {
            return Ok(());
        };
        if self.state.surface == Surface::Workspace {
            // The top-bar creation action uses the already published server capability.
            // Retire the client attachment, never the tmux session, before showing Home.
            self.cancel()?;
            self.state = State {
                request,
                home_phase: HomePhase::Live,
                fleet: self.state.fleet.clone(),
                sessions: self.state.sessions.clone(),
                status: "Connected".into(),
                ..State::default()
            };
        }
        self.state.request = request;
        self.accept_server(server)
    }
    pub(super) fn accept_server(&mut self, server: fleet::Server) -> Result<(), Error> {
        let Some(generation) = server.generation else {
            return Ok(());
        };
        self.state.selected_server = Some(fleet::SelectedServer {
            machine_id: self.machine_id.clone(),
            machine_label: self.machine_label.clone(),
            server_id: server.id,
            generation,
            label: server.label,
        });
        self.creation_status();
        self.publish()
    }
    pub(super) fn creation_status(&mut self) {
        let revision = self
            .state
            .create_session
            .as_ref()
            .map_or(0, |s| s.revision + 1);
        self.state.create_session = self.state.selected_server.as_ref().map(|_| CreateSession {
            phase: if self.uncertain_create.is_some() {
                CreatePhase::Failed
            } else {
                CreatePhase::Idle
            },
            error: self.uncertain_create.map(|id| {
                format!(
                    "Creation outcome unconfirmed ({id}); inspect sessions before creating another."
                )
            }),
            revision,
        });
        if let Some(id) = self.uncertain_create {
            self.state.status = format!(
                "Creation outcome unconfirmed ({id}); inspect sessions before creating another."
            );
        }
    }
    pub(super) fn create(&mut self, request: u64, name: String) -> Result<(), Error> {
        if !self.background_fleet.allows_current()
            || request != self.state.request
            || self.state.surface != Surface::Home
            || self.state.home_phase != HomePhase::Live
            || self.stage.is_some()
            || self.uncertain_create.is_some()
            || !self.foreground
        {
            return Ok(());
        }
        let Some(selected) = self.state.selected_server.as_ref().filter(|selected| {
            self.state
                .fleet
                .as_ref()
                .is_some_and(|fleet| selected.valid(fleet))
        }) else {
            return Ok(());
        };
        let scope = ServerScope {
            server_id: selected.server_id.clone(),
            generation: selected.generation.clone(),
        };
        let revision = self
            .state
            .create_session
            .as_ref()
            .map_or(0, |s| s.revision + 1);
        self.state.create_session = Some(CreateSession {
            phase: CreatePhase::Pending,
            error: None,
            revision,
        });
        self.state.status = "Creating session".into();
        self.stage = Some(Stage::Create {
            scope,
            operation_id: uuid::Uuid::new_v4(),
            name,
        });
        self.publish()
    }
    pub(super) fn creation_failed(
        &mut self,
        operation_id: uuid::Uuid,
        error: herdr_client::tmux_daemon::Error,
    ) -> Result<(), Error> {
        if matches!(
            error,
            herdr_client::tmux_daemon::Error::ActionUncertain { .. }
        ) {
            self.uncertain_create = Some(operation_id);
        }
        self.creation_status();
        if self.uncertain_create.is_none() {
            self.state.status =
                "Session creation failed before submission — refresh the catalog".into();
        }
        self.publish()
    }
    pub(super) fn creation_completed(
        &mut self,
        scope: ServerScope,
        receipt: CreatedSession,
    ) -> Result<(), Error> {
        let Some(live) = receipt.live_session_id else {
            self.uncertain_create = uuid::Uuid::parse_str(&receipt.operation_id).ok();
            self.creation_status();
            return self.publish();
        };
        self.creation_status();
        let key = uuid::Uuid::new_v4().to_string();
        self.targets.insert(key.clone(), Target { scope, live });
        self.state.sessions.push(Choice {
            id: key.clone(),
            label: receipt.display_name,
            pane_count: Some(1),
            window_id: None,
            browser_icon: None,
            window_label: None,
        });
        self.open(self.state.request, key, None)
    }
}

#[cfg(test)]
#[path = "browser_native_local_catalog_tests.rs"]
mod tests;
