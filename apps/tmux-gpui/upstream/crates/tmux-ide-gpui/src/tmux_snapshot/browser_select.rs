//! Selecting what the window shows: a session, pane, agent, machine or
//! Home, and the sidebar row that asks for one. Moved out of browser_ui.rs
//! unchanged, to keep that file under the line limit.
use super::*;
use crate::tmux_snapshot::{geometry, pending_input, session_open};
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn select(
        &mut self,
        selection: Selection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let recovering_rejected_input = self.browser_state.input_target_rejected
            && matches!(&selection, Selection::Pane(id) if self.browser_state.selected_pane.as_ref() == Some(id));
        self.cancel_pending_input(cx);
        self.cancel_tab_focus_restore();
        self.fit_settle.clear();
        self.sidebar_keyboard.active = false;
        self.attention.pending = None;
        self.cancel_attention();
        self.cancel_palette();
        self.palette.pending = None;
        self.divider = None;
        self.picker = None;
        self.pane_actions = None;
        self.browser_address = None;
        self.new_session = None;
        self.pending_session_open = None;
        self.header_controls = Default::default();
        let opening_session = match &selection {
            Selection::Session(id) => Some(id.clone()),
            Selection::FleetSession { session_id, .. } => Some(session_id.clone()),
            _ => None,
        };
        self.new_session_queued = None;
        self.clear_selection(cx);
        self.wheel = Default::default();
        window.blur(cx);
        self.discard_composition(cx);
        let Some(request) = self.next_navigation_request() else {
            return;
        };
        self.workspace_fleet_agents.pending = None;
        self.session_history.pending = None;
        self.session_tabs.pending = None;
        let changing_machine = matches!(
            selection,
            Selection::Machine(_)
                | Selection::MachineProfile { .. }
                | Selection::FleetSession { .. }
                | Selection::FleetServer(_)
        );
        let going_home = matches!(
            selection,
            Selection::Home
                | Selection::Refresh
                | Selection::Machine(_)
                | Selection::MachineProfile { .. }
                | Selection::FleetServer(_)
        );
        let selecting_pane = matches!(selection, Selection::Pane(_));
        // Another pane of the painted window: the bridge retargets its existing
        // attachment, so the window's frame stays valid while input is re-gated.
        let same_window_pane = match &selection {
            Selection::Pane(id)
                if self.frame.is_some()
                    && !self.browser_state.retained_preview
                    && self.browser_state.surface == browser::Surface::Workspace
                    && self.browser_state.regions.iter().any(|r| &r.id == id) =>
            {
                Some(id.clone())
            }
            _ => None,
        };
        let held_input = same_window_pane
            .as_deref()
            .and_then(|id| pending_input::Pending::capture(self, request, id));
        let command = match selection {
            Selection::WorkspaceAgent {
                from_request,
                roster_revision,
                key,
                session_id,
            } => browser::Command::OpenWorkspaceAgent {
                request,
                from_request,
                roster_revision,
                key,
                session_id,
            },
            Selection::Agent {
                from_request,
                roster_revision,
                key,
            } => browser::Command::OpenAgent {
                request,
                from_request,
                roster_revision,
                key,
            },
            Selection::Session(id) => browser::Command::Session { request, id },
            Selection::FleetServer(selection) => {
                browser::Command::FleetServer { request, selection }
            }
            Selection::FleetSession { selection, .. } => {
                browser::Command::FleetSession { request, selection }
            }
            Selection::Pane(id) => browser::Command::Pane { request, id },
            Selection::Machine(ssh_target) => browser::Command::Machine {
                request,
                ssh_target,
            },
            Selection::MachineProfile { id, revision } => browser::Command::MachineProfile {
                request,
                id,
                revision,
            },
            Selection::Home => browser::Command::Home { request },
            Selection::Refresh => browser::Command::Refresh { request },
        };
        if self
            .browser_commands
            .as_ref()
            .is_some_and(|s| s.try_send(command).is_ok())
        {
            if same_window_pane.is_some() {
                self.last_resize =
                    geometry::reselect_fit(self.last_resize, self.browser_request, request);
            }
            self.browser_request = request;
            self.pending_input = held_input;
            if recovering_rejected_input {
                // Explicit recovery starts a new attachment; no failed input is retained.
                self.input_interrupted = false;
                self.terminal_focus.focus(window, cx);
            }
            if self.pending_input.is_some() {
                self.terminal_focus.focus(window, cx);
            }
            self.pending_session_open =
                opening_session.map(|id| session_open::Intent::exact(request, id));
            if let Some(id) = same_window_pane {
                self.browser_state.selected_pane = Some(id);
            } else if selecting_pane && self.retain_window_transition(request, cx) {
                // A non-interactive outgoing presentation bridges the first worker poll.
            } else if !selecting_pane || !self.browser_state.retained_preview {
                self.frame = None;
                self.browser_state.retained_preview = false;
            }
            self.browser_state.input_ready = false;
            // retain_window_transition already assigned the quiet navigation status.
            // Replacing it here inserts a notice into the titlebar for the first
            // click frame, before the worker publishes the same retained preview.
            if !(self.browser_state.retained_preview
                && self.browser_state.status == "Switching window…")
            {
                self.browser_state.status = "Loading selection".into();
            }
            self.browser_state.surface = if going_home {
                browser::Surface::Home
            } else {
                browser::Surface::Workspace
            };
            if going_home {
                if let Some(session) = self.browser_state.selected_session.as_ref()
                    && self
                        .browser_state
                        .sessions
                        .iter()
                        .any(|choice| &choice.id == session)
                {
                    self.last_workspace_session = Some(session.clone());
                }
                self.browser_state.home_phase = browser::HomePhase::Loading;
                self.browser_state.selected_session = None;
                self.browser_state.selected_pane = None;
                self.browser_state.frame = None;
                self.browser_state.regions.clear();
                self.browser_state.copy_region = None;
            }
            if changing_machine {
                self.browser_state.selected_server = None;
                self.browser_state.create_session = None;
                self.last_workspace_session = None;
                self.browser_state.sessions.clear();
            }
            if !selecting_pane {
                self.browser_state.panes.clear();
            }
        } else {
            self.frame = None;
            self.browser_state.input_ready = false;
            self.browser_request = request;
            self.browser_commands = None;
            self.browser_state.status = "Connection lost. Reopen tmux-ide to reconnect.".into();
        }
        cx.notify();
    }
    pub(super) fn select_sidebar(
        &mut self,
        request: u64,
        target: &sidebar::Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_request != request
            || self.browser_state.request != request
            || !self.presence.ready()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || !self.marked.is_empty()
            || self.browser_commands.is_none()
            || !sidebar::current(&self.browser_state, target)
        {
            return;
        }
        if let sidebar::Target::HomeAgent { revision, key } = target {
            self.home_agent_select(request, *revision, key, window, cx);
            return;
        }
        if let sidebar::Target::FleetAgent {
            scope,
            revision,
            key,
        } = target
        {
            self.select_workspace_fleet_agent(request, *scope, *revision, key, cx);
            return;
        }
        self.select(
            match target {
                sidebar::Target::FleetAgent { .. } | sidebar::Target::HomeAgent { .. } => return,
                sidebar::Target::Home => Selection::Home,
                sidebar::Target::FleetSession {
                    selection, session, ..
                } => Selection::FleetSession {
                    selection: selection.clone(),
                    session_id: session.clone(),
                },
                sidebar::Target::Session(id) => Selection::Session(id.clone()),
                sidebar::Target::Pane { id, .. } => Selection::Pane(id.clone()),
            },
            window,
            cx,
        );
    }
}
