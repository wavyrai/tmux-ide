//! Native owner command dispatch.
use super::*;
impl Local {
    pub(super) fn command(&mut self, command: Command) -> Result<(), Error> {
        self.preempt_background_preference(&command)?;
        match command {
            command @ Command::OpenWorkspaceFleetAgent { .. } => {
                self.open_workspace_fleet_agent(command)
            }
            command @ (Command::PaletteObserve { .. } | Command::AttentionObserve { .. }) => {
                self.observe_picker(command)
            }
            command @ (Command::OpenPaletteAgent { .. } | Command::OpenAttentionAgent { .. }) => {
                self.open_picker_agent(command)
            }
            Command::HomeAgentRecovery {
                request,
                roster_revision,
                action,
            } => self.recover_agents(request, roster_revision, action),
            Command::HomeAgentFilter {
                request,
                roster_revision,
                machine_id,
            } => self.filter_agents(request, roster_revision, machine_id),
            command @ (Command::OpenAgent { .. } | Command::OpenWorkspaceAgent { .. }) => {
                self.open_agent(command)
            }
            Command::CreateLocalSession {
                request,
                action,
                name,
            } => self.create_local_session(request, action, name),
            Command::LocalSetup { request } => self.start_local_setup(request),
            Command::SessionTab {
                request,
                from_request,
                revision,
                action,
            } => self.navigate_tab(crate::tmux_snapshot::session_tabs::Result {
                request,
                from_request,
                revision,
                action,
                outcome: crate::tmux_snapshot::session_tabs::Outcome::Rejected,
            }),
            Command::SessionHistory {
                request,
                from_request,
                revision,
                action,
            } => self.navigate_history(crate::tmux_snapshot::session_history::Rejected {
                request,
                from_request,
                revision,
                action,
            }),
            Command::FleetPreference {
                request,
                revision,
                action,
                enabled,
            } => self.preference_command(request, revision, action, enabled),
            command @ (Command::FleetRetry { .. } | Command::FleetDisconnect { .. }) => {
                self.fleet_control(command)
            }
            Command::NativeOwnerAction { request } => self.owner_action(request),
            Command::NativeEditorOpen { value } => self.open_editor(value),
            Command::NativeEditorCancel { value } => {
                self.cancel_editor(Some(&value));
                Ok(())
            }
            Command::MachineProfile {
                request,
                id,
                revision,
            } => self.select_machine(request, id, revision),
            Command::Machine {
                request,
                ssh_target: Some(target),
            } => self.add_machine(request, target),
            Command::Machine {
                request,
                ssh_target: None,
            } => self.switch_local(request),
            Command::Machines { request, operation } => self.machine_operation(request, operation),
            Command::FleetServer { request, selection } => self.fleet_server(request, selection),
            Command::FleetSession { request, selection } if request > self.state.request => {
                self.fleet_session(request, selection)
            }
            Command::CreateSession { request, name } => self.create(request, name),
            Command::NativeHistory {
                id,
                request,
                operation_id,
                body,
                ..
            } => self.history(id, request, operation_id, body),
            Command::Home { request } | Command::Refresh { request }
                if request > self.state.request =>
            {
                self.home(request)
            }
            Command::Session { request, id } if request > self.state.request => {
                self.open(request, id, None)
            }
            Command::Pane { request, id } if request > self.state.request => {
                if self.state.panes.iter().any(|pane| pane.id == id)
                    && let Some(key) = self.state.selected_session.clone()
                {
                    return self.open(request, key, Some(id));
                }
                Ok(())
            }
            Command::Presence { active, revision } => {
                if revision < self.presence_revision {
                    return Ok(());
                }
                if !active || revision != self.presence_revision {
                    self.cancel_editor(None);
                }
                if !active && matches!(self.stage, Some(Stage::AgentOpen { .. })) {
                    self.unavailable("Agent selection interrupted — refresh to inspect sessions")?;
                }
                self.local_creation_presence(active)?;
                self.setup_presence(active)?;
                self.presence_revision = revision;
                self.foreground = active;
                if !active
                    && matches!(
                        self.stage,
                        Some(
                            Stage::Machines {
                                change: Some(_),
                                ..
                            } | Stage::AddMachine { .. }
                        )
                    )
                    && !self.submitted
                {
                    self.cancel_registry();
                    self.stage = None;
                    self.publish()?;
                }
                if !active && matches!(self.stage, Some(Stage::Issue { .. })) {
                    self.worker.cancel();
                    self.submitted = false;
                }
                if self.active.is_none() {
                    self.publish()?;
                }
                Ok(())
            }
            Command::NativePaneSelected {
                id,
                from_request,
                request,
                pane,
            } => {
                if let Some(route) = &mut self.active
                    && route.id == id
                    && route.request == from_request
                    && request > route.request
                {
                    self.split.cancel();
                    if matches!(
                        self.stage,
                        Some(Stage::History { .. } | Stage::Editor { .. } | Stage::Owner { .. })
                    ) {
                        self.worker.cancel();
                        self.stage = None;
                        self.submitted = false;
                    }
                    self.editor = Default::default();
                    self.owner = Default::default();
                    self.navigation.tabs.advance(from_request, request);
                    route.request = request;
                    self.state.request = request;
                    self.state.selected_pane = Some(pane);
                }
                Ok(())
            }
            Command::NativeTerminalReady {
                id,
                request,
                generation,
                live_session_id,
                input_ready,
                coherent,
                presence_revision,
                ..
            } => {
                if self.active.as_ref().is_some_and(|r| {
                    r.id == id
                        && r.request == request
                        && r.target.scope.generation == generation
                        && r.target.live == live_session_id
                }) && input_ready
                    && coherent
                    && self.foreground
                    && presence_revision == self.presence_revision
                {
                    self.recovery = None;
                    self.accept_visit()?;
                }
                Ok(())
            }
            command @ Command::NativeTerminalCatalog { .. } => self.native_catalog(command),
            Command::Appearance { system } => {
                if let Some(owner) = &mut self.appearance
                    && owner.system(system)
                {
                    self.state.appearance = Some(owner.publication());
                    self.publish()?;
                }
                Ok(())
            }
            Command::Theme { id } => {
                if let Some(owner) = &mut self.appearance {
                    owner.select(&id);
                    self.state.appearance = Some(owner.publication());
                    self.publish()?;
                }
                Ok(())
            }
            Command::NativeSplitLayout {
                id,
                request,
                sequence,
                window,
                ..
            } => {
                if let Some(response) =
                    self.split
                        .request(self.active.as_ref(), id, request, sequence, window)?
                {
                    self.emit(Incoming::Split(response))?;
                }
                Ok(())
            }
            Command::NativeTerminalRefresh {
                id,
                request,
                preferred_pane,
            } if self.foreground => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|route| route.id == id && route.request == request)
                    && let Some(key) = self.state.selected_session.clone()
                {
                    return self.open(request, key, preferred_pane);
                }
                Ok(())
            }
            Command::NativeTerminalInterrupted {
                id,
                request,
                generation,
                live_session_id,
                ..
            } => {
                if self.active.as_ref().is_some_and(|route| {
                    route.id == id
                        && route.request == request
                        && route.target.scope.generation == generation
                        && route.target.live == live_session_id
                }) {
                    return self.reconnect_start();
                }
                Ok(())
            }
            Command::FleetSession { .. }
            | Command::Home { .. }
            | Command::Refresh { .. }
            | Command::Session { .. }
            | Command::Pane { .. }
            | Command::NativeTerminalRefresh { .. } => Ok(()),
            // Unsupported development-path actions must not leave a pending
            // controller authorization waiting for a helper that does not exist.
            _ => self.unavailable(
                "This action is not yet available in the native catalog development path",
            ),
        }
    }
}
