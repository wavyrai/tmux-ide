//! Bounded catalog switcher. Labels are searchable display text, never command targets.
pub(super) mod attention;
pub(super) mod commands;
mod fleet_servers;
mod fonts;
mod machine;
mod machine_edit;
mod machine_remove;
mod navigation_commands;
mod new_agent;
pub(super) mod palette;
mod pane_close;
mod pane_commands;
mod reference;
mod render;
mod saved_machines;
mod sidebar_visibility;
mod theme_style;
use super::{SnapshotView, browser, browser_ui::Selection};
use crate::search_input::{Changed, SearchInput};
use commands::Action;
#[cfg(test)]
use commands::command_rows;
use gpui::{prelude::*, *};
use nucleo_matcher::{
    Config, Matcher, Utf32String,
    pattern::{CaseMatching, Normalization, Pattern},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Target {
    DirectNavigation(navigation_commands::Captured),
    Font(super::terminal_font::Choice),
    MachineEdit {
        id: String,
        revision: u64,
    },
    MachineRemove {
        id: String,
        revision: u64,
    },
    FleetServer(Option<String>),
    PaneAction {
        captured: Option<super::pane_actions::Target>,
        action: pane_commands::Action,
    },
    Machine {
        id: String,
        revision: u64,
    },
    MachineToggle {
        id: String,
        revision: u64,
        enabled: bool,
    },
    FleetRetry(String),
    FleetDisconnect(String),
    Attention {
        scope: u64,
        revision: u64,
        key: String,
    },
    Session(String),
    FleetSession {
        selection: String,
        session_id: String,
    },
    Pane(String),
    Theme(String),
    Command(Action),
}
#[derive(Clone)]
pub(super) struct Row {
    target: Target,
    label: String,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Font,
    Reference,
    Help,
    WhatsNew,
    Attention,
    Navigation,
    Theme,
    Commands,
    Machine,
    SavedMachines,
    ManageMachines,
}
impl Mode {
    fn is_reference(self) -> bool {
        matches!(self, Self::Reference | Self::Help | Self::WhatsNew)
    }
}
pub(super) struct Picker {
    mode: Mode,
    pane_scope: Option<super::pane_actions::Target>,
    error: Option<&'static str>,
    note: Option<&'static str>,
    removal: Option<machine_remove::Confirmation>,
    edit: Option<machine_edit::Form>,
    machine: Option<machine::Form>,
    closing: Option<pane_close::Confirmation>,
    agent: Option<new_agent::Form>,
    search: Entity<SearchInput>,
    _changed: Subscription,
    rows: Vec<Row>,
    selected: usize,
    request: u64,
    scroll: ScrollHandle,
}
fn rows(state: &browser::State, query: &str) -> Vec<Row> {
    let query: String = query.chars().take(256).collect();
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut matches = Vec::new();
    for (pane, choices) in [(false, &state.sessions), (true, &state.panes)] {
        if !pane && state.fleet.is_some() {
            continue;
        }
        for choice in choices.iter().take(512) {
            let label = format!(
                "{} · {}",
                if pane { "Pane" } else { "Session" },
                choice.label.chars().take(256).collect::<String>()
            );
            let text: Utf32String = label.as_str().into();
            if let Some(score) = pattern.score(text.slice(..), &mut matcher) {
                matches.push((
                    score,
                    Row {
                        target: if pane {
                            Target::Pane(choice.id.clone())
                        } else {
                            Target::Session(choice.id.clone())
                        },
                        label,
                    },
                ));
            }
        }
    }
    if let Some(fleet) = &state.fleet {
        for group in &fleet.groups {
            for session in &group.sessions {
                let (Some(selection), Some(session_id)) = (&session.selection, &session.session_id)
                else {
                    continue;
                };
                let label = session
                    .server_id
                    .as_ref()
                    .and_then(|id| group.servers.iter().find(|server| &server.id == id))
                    .map_or_else(
                        || format!("{} · {}", group.label, session.name),
                        |server| format!("{} · {} · {}", group.label, server.label, session.name),
                    );
                let text: Utf32String = label.as_str().into();
                if let Some(score) = pattern.score(text.slice(..), &mut matcher) {
                    matches.push((
                        score,
                        Row {
                            target: Target::FleetSession {
                                selection: selection.clone(),
                                session_id: session_id.clone(),
                            },
                            label,
                        },
                    ));
                }
            }
        }
    }
    matches.extend(
        fleet_servers::rows(state, "")
            .into_iter()
            .filter_map(|row| {
                let text: Utf32String = row.label.as_str().into();
                pattern
                    .score(text.slice(..), &mut matcher)
                    .map(|score| (score, row))
            }),
    );
    matches.sort_by_key(|item| std::cmp::Reverse(item.0));
    matches.into_iter().take(32).map(|(_, row)| row).collect()
}
fn theme_rows(state: &browser::State, query: &str) -> Vec<Row> {
    let query = query.to_lowercase();
    state.appearance.as_ref().map_or_else(Vec::new, |a| {
        a.options
            .iter()
            .filter(|o| {
                format!("{} {}", o.id, o.name)
                    .to_lowercase()
                    .contains(&query)
            })
            .map(|o| Row {
                target: Target::Theme(o.id.clone()),
                label: o.name.clone(),
            })
            .collect()
    })
}
fn current(state: &browser::State, target: &Target) -> bool {
    match target {
        Target::DirectNavigation(captured) => captured.current(state),
        Target::Font(_) => true,
        Target::FleetDisconnect(token) => state.fleet.as_ref().is_some_and(|fleet| {
            fleet
                .groups
                .iter()
                .any(|group| group.disconnect.as_ref() == Some(token))
        }),
        Target::FleetRetry(token) => state.fleet.as_ref().is_some_and(|fleet| {
            fleet
                .groups
                .iter()
                .any(|group| group.retry.as_ref() == Some(token))
        }),
        Target::MachineEdit { id, revision } | Target::MachineRemove { id, revision } => {
            state.machines.as_ref().is_some_and(|registry| {
                registry.available
                    && !registry.pending
                    && registry.revision == *revision
                    && registry.machines.iter().any(|p| &p.id == id)
            })
        }
        Target::MachineToggle {
            id,
            revision,
            enabled,
        } => state.machines.as_ref().is_some_and(|registry| {
            registry.available
                && !registry.pending
                && registry.revision == *revision
                && registry
                    .machines
                    .iter()
                    .any(|profile| profile.id == *id && profile.enabled != *enabled)
        }),
        Target::Machine { id, revision } => state.machines.as_ref().is_some_and(|registry| {
            registry.available
                && registry.revision == *revision
                && registry
                    .machines
                    .iter()
                    .any(|profile| profile.id == *id && profile.enabled)
        }),
        Target::FleetSession {
            selection,
            session_id,
        } => state
            .fleet
            .as_ref()
            .and_then(|f| f.session(selection))
            .is_some_and(|s| s.session_id.as_ref() == Some(session_id)),
        Target::Attention {
            scope,
            revision,
            key,
        } => state.attention_agents.as_ref().is_some_and(|p| {
            p.scope == *scope
                && p.roster.revision == *revision
                && p.roster.available(key)
                && p.roster.rows.iter().any(|r| r.key == *key && r.attention)
        }),
        Target::PaneAction { captured, .. } => captured
            .as_ref()
            .is_some_and(|target| target.current(state)),
        Target::FleetServer(token) => token.as_ref().is_some_and(|token| {
            state
                .fleet
                .as_ref()
                .is_some_and(|fleet| fleet.server(token).is_some())
        }),
        Target::Command(action) => action.available(state),
        Target::Session(id) => state.sessions.iter().any(|c| &c.id == id),
        Target::Pane(id) => state.panes.iter().any(|c| &c.id == id),
        Target::Theme(id) => state
            .appearance
            .as_ref()
            .is_some_and(|a| a.options.iter().any(|o| &o.id == id)),
    }
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn retry_fleet_machine(
        &mut self,
        request: u64,
        token: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.browser_commands.is_none()
            || request != self.browser_request
            || !self.browser_state.fleet.as_ref().is_some_and(|fleet| {
                fleet
                    .groups
                    .iter()
                    .any(|g| g.retry.as_deref() == Some(token))
            })
        {
            return false;
        }
        if self.browser_commands.as_ref().is_some_and(|sender| {
            sender
                .try_send(browser::Command::FleetRetry {
                    request,
                    retry: token.into(),
                })
                .is_ok()
        }) {
            return true;
        }
        // Home and F5 share the same visible failure surface; do not silently close it.
        if self.picker.is_none() {
            self.open_commands(window, cx);
        }
        if let Some(picker) = &mut self.picker {
            picker.error = Some("Couldn't retry. Try again.");
        }
        cx.notify();
        false
    }

    pub(in crate::tmux_snapshot) fn disconnect_fleet_machine(
        &mut self,
        request: u64,
        token: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.browser_commands.is_none()
            || request != self.browser_request
            || !self.browser_state.fleet.as_ref().is_some_and(|fleet| {
                fleet
                    .groups
                    .iter()
                    .any(|g| g.disconnect.as_deref() == Some(token))
            })
        {
            return false;
        }
        if self.browser_commands.as_ref().is_some_and(|sender| {
            sender
                .try_send(browser::Command::FleetDisconnect {
                    request,
                    disconnect: token.into(),
                })
                .is_ok()
        }) {
            return true;
        }
        // Home and F5 share the same visible failure surface; do not silently close it.
        if self.picker.is_none() {
            self.open_commands(window, cx);
        }
        if let Some(picker) = &mut self.picker {
            picker.error = Some("Couldn't disconnect. Try again.");
        }
        cx.notify();
        false
    }

    pub(super) fn close_header_pane(
        &mut self,
        target: super::pane_actions::Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_header_actions(window, cx);
        self.begin_pane_close(target, window, cx);
    }
    pub(super) fn open_header_actions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = super::pane_actions::Target::capture(&self.browser_state) else {
            return;
        };
        self.open_commands(window, cx);
        if let Some(picker) = &mut self.picker {
            picker.pane_scope = Some(target);
            picker.search.update(cx, |input, cx| {
                input.set_placeholder("Search pane actions…", cx)
            });
        }
        self.refresh_picker(cx);
    }
    pub(super) fn open_commands(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_picker_mode(Mode::Commands, window, cx);
        self.reopen_palette();
        self.sync_palette_query(cx);
    }
    pub(super) fn open_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_picker_mode(Mode::Navigation, window, cx);
    }
    pub(super) fn open_theme_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.browser_state.appearance.is_some() {
            self.open_picker_mode(Mode::Theme, window, cx);
        }
    }
    pub(super) fn copy_diagnostics(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.marked.is_empty() || self.new_session.is_some() || self.pane_actions.is_some() {
            return;
        }
        let mut state = self.browser_state.clone();
        if self.browser_commands.is_none()
            || self.browser_state.request != self.browser_request
            || !self.presence.ready()
            || self.frame.is_none()
            || !state.input_ready
            || state.retained_preview
            || state.surface != browser::Surface::Workspace
        {
            state.diagnostics = None;
        }
        let report = super::diagnostics::build(&state, self.developer_mode.enabled);
        self.present_diagnostics(report, window, cx);
    }
    fn present_diagnostics(
        &mut self,
        report: Result<String, super::diagnostics::Error>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_picker_mode(Mode::Commands, window, cx);
        if let Some(picker) = self.picker.as_mut() {
            match report {
                Ok(text) => {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                    picker.note = Some(
                        "Diagnostics copied. Terminal content and private connection details are excluded.",
                    );
                }
                Err(_) => {
                    picker.error = Some("Could not prepare diagnostics. Clipboard unchanged.")
                }
            }
        }
        cx.notify();
    }
    fn open_picker_mode(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        if self.browser_commands.is_none() && mode != Mode::Commands {
            return;
        }
        if mode == Mode::Font {
            self.list_terminal_fonts(cx);
        }
        self.sidebar_keyboard.active = false;
        self.cancel_attention();
        self.cancel_palette();
        self.header_controls = Default::default();
        self.pending_session_open = None;
        self.pane_actions = None;
        self.new_session = None;
        self.divider = None;
        self.discard_composition(cx);
        self.clear_selection(cx);
        let search = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(1024);
            input.set_placeholder(
                match mode {
                    Mode::Font => "Search installed terminal fonts…",
                    Mode::Reference => "Search keyboard shortcuts…",
                    Mode::Help => "Search help…",
                    Mode::WhatsNew => "Search native preview changes…",
                    Mode::Attention => "Search attention agents…",
                    Mode::SavedMachines => "Search saved machines…",
                    Mode::ManageMachines => "Search machine actions…",
                    Mode::Machine => "SSH alias or user@host",
                    Mode::Theme => "Search themes…",
                    Mode::Commands => "Search commands…",
                    Mode::Navigation => "Search sessions and panes…",
                },
                cx,
            );
            input.set_appearance(crate::config::Config::default().ui, self.theme(), cx);
            input
        });
        let changed = cx.subscribe(&search, |view, _, _: &Changed, cx| {
            view.refresh_picker(cx);
            cx.notify();
        });
        search.read(cx).focus.clone().focus(window, cx);
        self.picker = Some(Picker {
            mode,
            pane_scope: None,
            error: None,
            note: None,
            removal: None,
            edit: None,
            machine: (mode == Mode::Machine).then(|| machine::Form::new(cx)),
            closing: None,
            agent: None,
            search,
            _changed: changed,
            rows: if mode == Mode::Font {
                fonts::rows(&self.terminal_font, "")
            } else if mode.is_reference() {
                reference::rows(mode, "")
            } else if mode == Mode::Attention {
                Vec::new()
            } else if mode == Mode::ManageMachines {
                saved_machines::management_rows(&self.browser_state, "")
            } else if mode == Mode::SavedMachines {
                saved_machines::rows(&self.browser_state, "")
            } else if mode == Mode::Machine {
                Vec::new()
            } else if mode == Mode::Commands {
                commands::command_rows_with_settings(
                    &self.browser_state,
                    "",
                    self.sidebar_hidden,
                    self.developer_mode.enabled,
                )
            } else if mode == Mode::Theme {
                theme_rows(&self.browser_state, "")
            } else {
                rows(&self.browser_state, "")
            },
            selected: 0,
            request: self.browser_request,
            scroll: ScrollHandle::new(),
        });
        if let Some(picker) = &mut self.picker {
            navigation_commands::retain_palette_scope(&mut picker.rows, self.palette.active);
            navigation_commands::bind(&mut picker.rows, picker.search.entity_id());
        }
        cx.notify();
    }
    pub(super) fn refresh_picker(&mut self, cx: &mut Context<Self>) {
        self.sync_palette_query(cx);
        if self.attention.active.is_some_and(|(request, _)| {
            request != self.browser_request || self.browser_commands.is_none()
        }) {
            self.cancel_attention();
            self.cancel_palette();
        }
        let theme = self.theme();
        let Some(picker) = &mut self.picker else {
            return;
        };
        picker.search.update(cx, |input, cx| {
            input.set_appearance(crate::config::Config::default().ui, theme, cx)
        });
        if (self.browser_commands.is_none() && picker.mode != Mode::Commands)
            || picker.pane_scope.as_ref().is_some_and(|target| {
                !self.presence.ready() || !target.current(&self.browser_state)
            })
            || (picker.mode != Mode::Theme
                && (picker.request != self.browser_request
                    || (picker.mode == Mode::Navigation
                        && rows(&self.browser_state, "").is_empty())))
        {
            self.picker = None;
            return;
        }
        picker.rows = if picker.mode == Mode::Font {
            fonts::rows(&self.terminal_font, picker.search.read(cx).text())
        } else if picker.mode.is_reference() {
            reference::rows(picker.mode, picker.search.read(cx).text())
        } else if picker.mode == Mode::Attention {
            attention::rows(
                &self.browser_state,
                self.attention.active,
                picker.search.read(cx).text(),
            )
        } else if picker.mode == Mode::ManageMachines {
            saved_machines::management_rows(&self.browser_state, picker.search.read(cx).text())
        } else if picker.mode == Mode::SavedMachines {
            saved_machines::rows(&self.browser_state, picker.search.read(cx).text())
        } else if picker.mode == Mode::Machine {
            Vec::new()
        } else if picker.mode == Mode::Commands {
            commands::command_rows_with_settings(
                &self.browser_state,
                picker.search.read(cx).text(),
                self.sidebar_hidden,
                self.developer_mode.enabled,
            )
        } else if picker.mode == Mode::Theme {
            theme_rows(&self.browser_state, picker.search.read(cx).text())
        } else {
            rows(&self.browser_state, picker.search.read(cx).text())
        };
        navigation_commands::retain_palette_scope(&mut picker.rows, self.palette.active);
        navigation_commands::bind(&mut picker.rows, picker.search.entity_id());
        if picker.pane_scope.is_some() {
            picker.rows.retain(|row| matches!(&row.target, Target::PaneAction { action, .. }
                if !matches!(action, pane_commands::Action::NewWindow | pane_commands::Action::NewAgent)));
        }
        picker.selected = picker.selected.min(picker.rows.len().saturating_sub(1));
    }
    fn close_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cancel_attention();
        self.cancel_palette();
        self.picker = None;
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
    /// Opens Add machine, for the dev-only capture example.
    #[cfg(feature = "visual-capture")]
    pub(super) fn open_add_machine_for_capture(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_picker_mode(Mode::Machine, window, cx);
    }

    fn choose_picker(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker.as_ref().is_some_and(|p| p.mode.is_reference()) {
            return;
        }
        if let Target::Font(choice) = &target {
            if self
                .picker
                .as_ref()
                .is_some_and(|p| p.mode == Mode::Font && p.request == self.browser_request)
            {
                self.choose_terminal_font(choice.clone(), cx);
            }
            return;
        }
        if self.picker.as_ref().is_some_and(|p| p.mode == Mode::Font) {
            return;
        }
        if let Some(scope) = self
            .picker
            .as_ref()
            .and_then(|picker| picker.pane_scope.as_ref())
            && !matches!(&target, Target::PaneAction { captured: Some(captured), action }
                if captured == scope && !matches!(action, pane_commands::Action::NewWindow | pane_commands::Action::NewAgent))
        {
            return;
        }
        if self
            .picker
            .as_ref()
            .is_none_or(|p| p.mode != Mode::Theme && p.request != self.browser_request)
            || (self.browser_commands.is_none()
                && !matches!(&target, Target::Command(Action::CopyDiagnostics)))
            || !current(&self.browser_state, &target)
        {
            return;
        }
        if let Target::DirectNavigation(captured) = target {
            self.choose_direct_navigation(captured, window, cx);
            return;
        }
        if let Target::Attention {
            scope,
            revision,
            key,
        } = &target
        {
            self.choose_attention(*scope, *revision, key, cx);
            return;
        }
        if let Target::FleetDisconnect(token) = &target {
            if self.disconnect_fleet_machine(self.browser_request, token, window, cx) {
                self.close_picker(window, cx);
            }
            return;
        }
        if let Target::FleetRetry(token) = &target {
            if self.retry_fleet_machine(self.browser_request, token, window, cx) {
                self.close_picker(window, cx);
            }
            return;
        }
        if let Target::PaneAction { captured, action } = &target {
            self.choose_pane_command(captured.as_ref(), *action, window, cx);
            return;
        }
        if let Target::FleetServer(Some(token)) = &target {
            if self
                .picker
                .as_ref()
                .is_some_and(|picker| matches!(picker.mode, Mode::Commands | Mode::Navigation))
            {
                self.open_fleet_server(self.browser_request, token, window, cx);
            }
            return;
        }
        if matches!(
            &target,
            Target::Command(
                Action::ToggleSidebar
                    | Action::DeveloperMode(_)
                    | Action::CopyDiagnostics
                    | Action::Shortcuts
                    | Action::Help
                    | Action::WhatsNew
                    | Action::Fonts
            )
        ) && (!self.marked.is_empty()
            || self.picker.as_ref().is_none_or(|p| {
                p.mode != Mode::Commands
                    || p.search.read(cx).is_composing()
                    || p.agent.is_some()
                    || p.closing.is_some()
                    || p.edit.is_some()
                    || p.removal.is_some()
            }))
        {
            return;
        }
        if matches!(&target, Target::Command(Action::DeveloperMode(_)))
            && (!self.developer_mode.ready || self.developer_mode.saving)
        {
            return;
        }
        if let Target::Command(action) = target {
            self.close_picker(window, cx);
            match action {
                Action::CopyDiagnostics => self.copy_diagnostics(window, cx),
                Action::DeveloperMode(enabled) => {
                    self.set_developer_mode(enabled, cx);
                    self.open_picker_mode(Mode::Commands, window, cx);
                }
                Action::Fonts => self.open_picker_mode(Mode::Font, window, cx),
                Action::Shortcuts => self.open_picker_mode(Mode::Reference, window, cx),
                Action::Help => self.open_picker_mode(Mode::Help, window, cx),
                Action::WhatsNew => self.open_picker_mode(Mode::WhatsNew, window, cx),
                Action::ToggleSidebar => self.toggle_sidebar(cx),
                Action::SavedMachines => self.open_saved_machines(window, cx),
                Action::ManageMachines => self.open_machine_management(window, cx),
                Action::AddMachine => self.open_picker_mode(Mode::Machine, window, cx),
                Action::LocalMachine => self.select(Selection::Machine(None), window, cx),
                Action::Home => self.select(Selection::Home, window, cx),
                Action::Terminals => self.dispatch_application_tab(
                    self.browser_request,
                    super::workspace_chrome::ApplicationTab::Terminals,
                    window,
                    cx,
                ),
                Action::Sessions => self.open_picker(window, cx),
                Action::Appearance => self.open_theme_picker(window, cx),
                Action::Refresh => self.select(Selection::Refresh, window, cx),
            }
            return;
        }
        if let Target::MachineEdit { id, revision } = &target {
            self.begin_machine_edit(id, *revision, window, cx);
            return;
        }
        if let Target::MachineRemove { id, revision } = &target {
            self.begin_machine_removal(id, *revision, window, cx);
            return;
        }
        if let Target::MachineToggle {
            id,
            revision,
            enabled,
        } = target
        {
            let change = if enabled {
                browser::machines::Change::Enable { id }
            } else {
                browser::machines::Change::Disable { id }
            };
            if let Some(sender) = &self.browser_commands {
                let error = sender
                    .try_send(browser::Command::Machines {
                        request: self.browser_request,
                        operation: browser::machines::Operation::Mutate { revision, change },
                    })
                    .err()
                    .map(|_| "Machine change queue unavailable — try again");
                if let Some(picker) = &mut self.picker {
                    picker.error = error;
                }
                cx.notify();
            }
            return;
        }
        if let Target::Theme(id) = target {
            // Queueing is not a save acknowledgement; only publications update selection.
            if let Some(sender) = &self.browser_commands {
                let error = sender
                    .try_send(browser::Command::Theme { id })
                    .err()
                    .map(|_| "Theme command queue unavailable — try again");
                if let Some(picker) = &mut self.picker {
                    picker.error = error;
                }
                cx.notify();
            }
            return;
        }
        self.close_picker(window, cx);
        self.select(
            match target {
                Target::Machine { id, revision } => Selection::MachineProfile { id, revision },
                Target::Session(id) => Selection::Session(id),
                Target::FleetSession {
                    selection,
                    session_id,
                } => Selection::FleetSession {
                    selection,
                    session_id,
                },
                Target::Pane(id) => Selection::Pane(id),
                Target::DirectNavigation(_)
                | Target::Font(_)
                | Target::FleetServer(_)
                | Target::PaneAction { .. }
                | Target::Attention { .. }
                | Target::Theme(_)
                | Target::Command(_)
                | Target::MachineToggle { .. }
                | Target::MachineRemove { .. }
                | Target::MachineEdit { .. }
                | Target::FleetRetry(_)
                | Target::FleetDisconnect(_) => return,
            },
            window,
            cx,
        );
    }
    pub(super) fn show_pane_action_queue_error(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_commands(window, cx);
        if let Some(picker) = &mut self.picker {
            picker.error = Some("Action queue unavailable — cancel and reselect the pane.");
        }
        cx.notify();
    }

    pub(super) fn picker_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pane_shortcut_key(event, window, cx) || self.session_tabs_key(event, window, cx) {
            return;
        }
        if self.session_history_key(event, window, cx) {
            return;
        }
        if self.new_session.is_some() {
            self.new_session_key(event, window, cx);
            return;
        }
        if self.pane_actions.is_some() {
            self.pane_actions_key(event, window, cx);
            return;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|p| p.search.read(cx).is_composing())
        {
            return;
        }
        if self.picker.as_ref().is_some_and(|p| p.closing.is_some()) {
            self.pane_close_key(event, window, cx);
            return;
        }
        if self.picker.as_ref().is_some_and(|p| p.agent.is_some()) {
            self.new_agent_key(event, window, cx);
            return;
        }
        if self.machine_edit_composing(cx) {
            return;
        }
        if self.home_search_composing(window, cx) {
            return;
        }
        if self.sidebar_keyboard_key(event, window, cx) {
            return;
        }
        if self.home_filter_key(event, window, cx) {
            return;
        }
        let key = &event.keystroke;
        if key.key == "f10" && commands::shortcut(key) {
            if !event.is_held && self.picker.is_none() && self.marked.is_empty() {
                self.toggle_sidebar(cx);
            }
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if commands::shortcut(key) {
            match key.key.as_str() {
                "f1" => self.dispatch_application_tab(
                    self.browser_request,
                    super::workspace_chrome::ApplicationTab::Home,
                    window,
                    cx,
                ),
                "f2" => {
                    if self.picker.is_some() {
                        self.close_picker(window, cx);
                    }
                    self.dispatch_application_tab(
                        self.browser_request,
                        super::workspace_chrome::ApplicationTab::Terminals,
                        window,
                        cx,
                    );
                }
                "f6" => self.open_picker(window, cx),
                "f7" => self.open_attention(window, cx),
                _ => self.open_commands(window, cx),
            }
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if key.modifiers.platform
            && !key.modifiers.control
            && !key.modifiers.alt
            && matches!(key.key.as_str(), "k" | "p")
        {
            self.open_picker(window, cx);
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|picker| picker.edit.is_some())
        {
            self.machine_edit_key(event, window, cx);
            return;
        }
        if self.picker.as_ref().is_some_and(|p| p.removal.is_some()) {
            self.machine_removal_key(event, window, cx);
            return;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|p| p.mode == Mode::Machine)
        {
            self.machine_key(event, window, cx);
            return;
        }
        let Some(picker) = &mut self.picker else {
            return;
        };
        if picker.search.read(cx).is_composing() {
            return;
        }
        match key.key.as_str() {
            "escape" if picker.mode.is_reference() => self.open_commands(window, cx),
            "escape" => self.close_picker(window, cx),
            "up" => picker.selected = picker.selected.saturating_sub(1),
            "down" => {
                picker.selected = (picker.selected + 1).min(picker.rows.len().saturating_sub(1))
            }
            "enter" => {
                let target = picker
                    .rows
                    .get(picker.selected)
                    .map(|row| row.target.clone());
                if let Some(target) = target {
                    self.choose_picker(target, window, cx);
                }
            }
            _ => return,
        }
        if let Some(picker) = &self.picker {
            picker.scroll.scroll_to_item(picker.selected);
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
    }
}
#[cfg(test)]
mod tests;
