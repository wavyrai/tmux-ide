#[path = "sidebar.rs"]
pub(super) mod sidebar;
pub(super) use sidebar::Keyboard as SidebarKeyboard;
#[path = "workspace_agents.rs"]
mod workspace_agents;
use super::{SnapshotView, browser};
use bezel_ui::widgets::Status;
use gpui::{prelude::*, *};
pub(super) enum Selection {
    WorkspaceAgent {
        from_request: u64,
        roster_revision: u64,
        key: String,
        session_id: String,
    },
    Agent {
        from_request: u64,
        roster_revision: u64,
        key: String,
    },
    Home,
    Machine(Option<String>),
    MachineProfile {
        id: String,
        revision: u64,
    },
    Refresh,
    Session(String),
    FleetServer(String),
    FleetSession {
        selection: String,
        session_id: String,
    },
    Pane(String),
}
impl SnapshotView {
    fn terminal_wheel(
        &mut self,
        event: &ScrollWheelEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_state.retained_preview {
            self.wheel = Default::default();
            return;
        }
        if self.pane_actions.is_some() || self.new_session.is_some() {
            return;
        }
        self.divider = None;
        self.clear_selection(cx);
        if !self.presence.ready()
            || !super::hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref())
        {
            self.wheel = Default::default();
            return;
        }
        let (Some((bounds, _)), Some(width)) = (self.input_geometry, self.input_cell_width) else {
            return;
        };
        let point = event.position - bounds.origin;
        let target = super::hit_regions::hit(
            &self.browser_state.regions,
            f32::from(point.x),
            f32::from(point.y),
            width,
            self.terminal_height(),
        );
        if !bounds.contains(&event.position)
            || target != self.browser_state.selected_pane.as_deref()
            || target.is_none()
        {
            self.wheel = Default::default();
            return;
        }
        if self.browser_state.history_offset == 0
            && !event.modifiers.shift
            && !self.offer_terminal_input(cx)
        {
            self.wheel = Default::default();
            return;
        }
        let Some(region) =
            self.browser_state.regions.iter().find(|region| {
                Some(region.id.as_str()) == self.browser_state.selected_pane.as_deref()
            })
        else {
            return;
        };
        let col = (f32::from(point.x) / width).floor() as u16 - region.left;
        let row = (f32::from(point.y) / self.terminal_height()).floor() as u16 - region.top;
        if matches!(event.touch_phase, TouchPhase::Started) {
            self.wheel = Default::default();
        }
        let delta = match event.delta {
            ScrollDelta::Pixels(p) => f32::from(p.y) / self.terminal_height(),
            ScrollDelta::Lines(p) => p.y,
        };
        let lines = self.wheel.add(delta);
        if lines != 0 {
            self.discard_composition(cx);
            self.queue_input(
                super::keys::Input::Wheel {
                    lines,
                    row,
                    col,
                    shift: event.modifiers.shift,
                    alt: event.modifiers.alt,
                    control: event.modifiers.control,
                },
                cx,
            );
        }
        cx.stop_propagation();
    }
    fn terminal_key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some() {
            return;
        }
        // Let application navigation consume its keys before terminal input forwarding.
        if super::picker::commands::shortcut(&event.keystroke)
            || super::session_history::shortcut(&event.keystroke)
            || super::session_tabs::shortcut(&event.keystroke)
            || sidebar::focus_shortcut(&event.keystroke)
        {
            return;
        }
        self.cancel_tab_focus_restore();
        self.cancel_tab_selection_restore();
        if self.browser_state.retained_preview {
            self.interrupt_input(cx);
            cx.stop_propagation();
            return;
        }
        if self.divider.is_some() && !event.keystroke.modifiers.platform {
            if event.keystroke.key == "escape" {
                self.divider = None;
                cx.notify();
            } else {
                self.interrupt_input(cx);
            }
            cx.stop_propagation();
            return;
        }
        let key = &event.keystroke;
        let paste = key.modifiers.platform
            && !key.modifiers.control
            && !key.modifiers.alt
            && !key.modifiers.shift
            && key.key == "v";
        let local_scroll = key.modifiers.shift
            && !key.modifiers.control
            && !key.modifiers.alt
            && !key.modifiers.platform
            && matches!(key.key.as_str(), "pageup" | "pagedown" | "end");
        // Application shortcuts and local selection/history commands are not terminal input.
        if self.selection.is_none()
            && (!key.modifiers.platform || paste)
            && !local_scroll
            && !self.offer_terminal_input(cx)
        {
            cx.stop_propagation();
            return;
        }
        if !self.presence.ready() || self.frame.is_none() {
            return;
        }
        let key = &event.keystroke;
        if let Some(selection) = &self.selection {
            if key.modifiers.platform
                && !key.modifiers.control
                && !key.modifiers.alt
                && key.key == "c"
            {
                match selection.text() {
                    Ok(text) if !text.is_empty() => {
                        cx.write_to_clipboard(ClipboardItem::new_string(text))
                    }
                    Ok(_) => {}
                    Err(_) => {
                        self.clear_selection(cx);
                        self.browser_state.status = "Selection exceeds copy limit".into();
                        cx.notify();
                    }
                }
            } else if key.key == "escape" {
                self.clear_selection(cx);
            }
            cx.stop_propagation();
            return;
        }
        if key.modifiers.platform
            && key.modifiers.shift
            && !key.modifiers.control
            && !key.modifiers.alt
            && key.key == "c"
        {
            if super::hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref())
                && let (Some(frame), Some(region)) = (&self.frame, &self.browser_state.copy_region)
            {
                match region.text(frame) {
                    Ok(text) if !text.is_empty() => {
                        cx.write_to_clipboard(ClipboardItem::new_string(text))
                    }
                    Ok(_) => {}
                    Err(_) => {
                        self.browser_state.status =
                            "Copy unavailable: pane exceeds the text limit".into();
                        cx.notify();
                    }
                }
            }
            cx.stop_propagation();
            return;
        }
        if key.modifiers.shift
            && !key.modifiers.control
            && !key.modifiers.alt
            && !key.modifiers.platform
        {
            let scroll = match key.key.as_str() {
                "pageup" | "pagedown" => {
                    // A page is the selected pane's current content, excluding
                    // sibling panes and status rows in the composed canvas.
                    let region = self.browser_state.copy_region.as_ref().filter(|region| {
                        self.browser_state.request == self.browser_request
                            && self.frame.as_ref().is_some_and(|frame| {
                                region.valid(frame, self.browser_state.selected_pane.as_deref())
                            })
                    });
                    let Some(region) = region else {
                        cx.stop_propagation();
                        return;
                    };
                    let rows = region.height.saturating_sub(1).clamp(1, 1000) as i16;
                    Some(if key.key == "pageup" { rows } else { -rows })
                }
                "end" => Some(0),
                _ => None,
            };
            if let Some(lines) = scroll {
                self.discard_composition(cx);
                self.queue_input(super::keys::Input::Scroll(lines), cx);
                cx.stop_propagation();
                return;
            }
        }
        if !self.browser_state.input_ready {
            return;
        }
        if !self.marked.is_empty() {
            return;
        }
        let key = &event.keystroke;
        // On macOS Option belongs to the input method (dead keys/non-US layouts).
        // Meta sequences can still be entered with Escape followed by the key.
        #[cfg(target_os = "macos")]
        if key.modifiers.alt && !key.modifiers.control && !key.modifiers.platform {
            return;
        }
        let paste = key.modifiers.platform
            && !key.modifiers.control
            && !key.modifiers.alt
            && !key.modifiers.shift
            && key.key == "v";
        let input = if paste {
            cx.stop_propagation();
            let text = cx.read_from_clipboard().and_then(|item| item.text());
            let input = text.and_then(super::keys::clipboard_text);
            if input.is_none() {
                self.browser_state.status =
                    "Paste rejected — use nonempty text up to 64 KiB without NUL or Escape".into();
                cx.notify();
            }
            input
        } else {
            super::keys::translate(key)
        };
        let Some(input) = input else {
            return;
        };
        if matches!(input, super::keys::Input::Text(_)) {
            // AppKit owns text and IME commits; handling it here would duplicate input.
            return;
        }
        self.queue_input(input, cx);
        cx.stop_propagation();
    }
    pub(super) fn queue_input(&mut self, input: super::keys::Input, cx: &mut Context<Self>) {
        let terminal = matches!(
            input,
            super::keys::Input::Text(_)
                | super::keys::Input::Paste(_)
                | super::keys::Input::Key(_)
                | super::keys::Input::Bytes(_)
        );
        if self.browser_state.retained_preview {
            if terminal {
                self.interrupt_input(cx);
            }
            return;
        }
        if terminal && (self.selection.is_some() || !self.offer_terminal_input(cx)) {
            return;
        }
        let Some(id) = self.browser_state.selected_pane.clone() else {
            return;
        };
        let command = browser::Command::Input {
            request: self.browser_request,
            id,
            input,
        };
        if self
            .browser_commands
            .as_ref()
            .is_none_or(|s| s.try_send(command).is_err())
        {
            if terminal {
                self.interrupt_input(cx);
            }
            self.browser_state.input_ready = false;
            self.browser_state.status = "Input queue unavailable — reselect the pane".into();
            cx.notify();
        }
    }

    pub(super) fn select(
        &mut self,
        selection: Selection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
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
                    super::geometry::reselect_fit(self.last_resize, self.browser_request, request);
            }
            self.browser_request = request;
            self.pending_session_open =
                opening_session.map(|id| super::session_open::Intent::exact(request, id));
            if let Some(id) = same_window_pane {
                self.browser_state.selected_pane = Some(id);
            } else if !selecting_pane || !self.browser_state.retained_preview {
                self.frame = None;
                self.browser_state.retained_preview = false;
            }
            self.browser_state.input_ready = false;
            self.browser_state.status = "Loading selection".into();
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
            self.browser_state.status =
                "Connection busy or unavailable — restart the preview".into();
        }
        cx.notify();
    }
    fn select_sidebar(
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
        if let sidebar::Target::FleetAgent {
            scope,
            revision,
            key,
        } = target
        {
            self.select_workspace_fleet_agent(request, *scope, *revision, key, cx);
            return;
        }
        if let sidebar::Target::Collapse {
            revision,
            action,
            enabled,
            ..
        } = target
        {
            self.change_fleet_preference(request, *revision, action, *enabled, cx);
            return;
        }
        self.select(
            match target {
                sidebar::Target::Collapse { .. } | sidebar::Target::FleetAgent { .. } => return,
                sidebar::Target::FleetSession {
                    selection, session, ..
                } => Selection::FleetSession {
                    selection: selection.clone(),
                    session_id: session.clone(),
                },
                sidebar::Target::FleetServer { selection, .. } => {
                    Selection::FleetServer(selection.clone())
                }
                sidebar::Target::Session(id) => Selection::Session(id.clone()),
                sidebar::Target::Pane { id, .. } => Selection::Pane(id.clone()),
            },
            window,
            cx,
        );
    }
    pub(super) fn select_window(
        &mut self,
        request: u64,
        session: &str,
        choice: &super::navigation::WindowChoice,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_state.selected_pane.as_ref() == Some(&choice.pane)
            || !self
                .browser_state
                .panes
                .iter()
                .any(|pane| pane.id == choice.pane && pane.window_id.as_ref() == Some(&choice.id))
        {
            return;
        }
        self.select_sidebar(
            request,
            &sidebar::Target::Pane {
                session: session.into(),
                id: choice.pane.clone(),
            },
            window,
            cx,
        );
    }
    pub(super) fn browser_render(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.observe_pointer();
        self.prepare_home_filter(cx);
        self.reconcile_sidebar_keyboard(window, cx);
        self.restore_tab_focus(window, cx);
        self.restore_tab_selection();
        self.agent_animation.begin_render();
        // GPUI dispatches shortcuts along the focused element path. Initial catalog
        // and selection transitions have no focused control; retain navigation without
        // granting terminal authority or clearing an interrupted-input latch.
        if window.focused(cx).is_none()
            && self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
        {
            self.terminal_focus.focus(window, cx);
        }
        let theme = self.theme();
        let is_home = self.browser_state.surface == browser::Surface::Home;
        let show_sidebar = !is_home && !self.sidebar_hidden;
        let viewport = window.viewport_size();
        // One material backs the header, sidebar and the gutter around opaque content.
        let glass = self.glass.sync(
            window,
            Bounds::new(point(px(0.), px(0.)), viewport),
            theme.surface,
        );
        super::design::prepare(&theme, glass, cx);
        let mut sidebar = div()
            .id("session-list")
            .debug_selector(|| "session-list".into())
            .track_scroll(&self.sidebar_keyboard.scroll)
            .when_some(self.sidebar_keyboard.focus.as_ref(), |list, focus| {
                list.track_focus(focus)
            })
            .w_full()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p_2()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .px_2()
                    .pt_3()
                    .pb_1()
                    .text_color(rgb(theme.muted))
                    .child(if self.browser_state.workspace_fleet_agents.is_some() {
                        "Fleet"
                    } else {
                        "Sessions"
                    }),
            );
        let request = self.browser_request;
        for (index, row) in sidebar::rows(&self.browser_state).into_iter().enumerate() {
            let mut element = sidebar::render_row(index, &row, &theme, self.accent(), glass).when(
                self.sidebar_keyboard.active
                    && (row.target.as_ref().is_some_and(|target| {
                        Some(target) == self.sidebar_keyboard.selected.as_ref()
                    }) || row.machine.as_ref().is_some_and(|machine| {
                        Some(machine) == self.sidebar_keyboard.machine_focus.as_ref()
                    })),
                |row| row.border_1().border_color(rgb(self.accent())),
            );
            if let Some(key) = &row.agent
                && let Some(publication) = &self.browser_state.workspace_fleet_agents
                && let Some(agent) = publication.roster.rows.iter().find(|r| &r.key == key)
            {
                element =
                    element.child(self.agent_indicator(agent, !publication.roster.available(key)));
            }
            if let Some((action, favorite)) = &row.favorite {
                element = element.child(self.fleet_preference_button(
                    ("sidebar-favorite", index),
                    action.as_deref(),
                    !*favorite,
                    if *favorite {
                        "Remove favorite"
                    } else {
                        "Add favorite"
                    },
                    if *favorite {
                        "icons/fleet-star-filled.svg"
                    } else {
                        "icons/fleet-star.svg"
                    },
                    cx,
                ));
            }
            if let Some(target) = row.target {
                element =
                    element
                        .cursor_pointer()
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.select_sidebar(request, &target, window, cx);
                        }));
            }
            sidebar = sidebar.child(element);
        }
        if let Some(status) = self.fleet_preference_status() {
            sidebar = sidebar.child(
                div()
                    .text_sm()
                    .text_color(rgb(theme.muted))
                    .child(status.to_owned()),
            );
        }
        sidebar = sidebar.children(self.workspace_agent_rows(cx));
        sidebar = div()
            .id("sidebar-viewport")
            .debug_selector(|| "tmux-sidebar-viewport".into())
            .relative()
            .w(px(224.))
            .h_full()
            .min_h_0()
            .flex_shrink_0()
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(sidebar)
            .child(self.sidebar_footer(cx));
        let application_tabs = self.application_tabs(window, cx);
        let window_strip = self.workspace_window_strip(window, cx);
        let status = if self.browser_state.retained_preview {
            if self.browser_state.status.starts_with("Restoring terminal…") {
                self.browser_state.status.clone()
            } else {
                format!("Restoring terminal… — {}", self.browser_state.status)
            }
        } else if self.selection.is_some() {
            "Selecting captured frame — Cmd-C copies; Escape or click resumes".into()
        } else if self.input_interrupted {
            format!(
                "Input interrupted; click terminal when ready, then retype — {}",
                self.browser_state.status
            )
        } else {
            self.browser_state.status.clone()
        };
        let show_status = super::status_presentation::visible(
            &status,
            self.developer_mode.enabled,
            self.browser_state.input_ready,
        );
        let terminal = (self.browser_state.surface != browser::Surface::Home).then(|| {
            div()
                .size_full()
                .track_focus(&self.terminal_focus)
                .on_mouse_down(MouseButton::Left, cx.listener(Self::terminal_click))
                .on_mouse_down(MouseButton::Middle, cx.listener(Self::terminal_click))
                .on_mouse_down(MouseButton::Right, cx.listener(Self::terminal_click))
                .on_mouse_move(cx.listener(Self::terminal_drag))
                .on_mouse_up(MouseButton::Left, cx.listener(Self::terminal_release))
                .on_mouse_up(MouseButton::Middle, cx.listener(Self::terminal_release))
                .on_mouse_up(MouseButton::Right, cx.listener(Self::terminal_release))
                .on_mouse_up_out(MouseButton::Middle, cx.listener(Self::terminal_release))
                .on_mouse_up_out(MouseButton::Right, cx.listener(Self::terminal_release))
                .on_mouse_up_out(MouseButton::Left, cx.listener(Self::terminal_release))
                .on_key_down(cx.listener(Self::terminal_key))
                .on_scroll_wheel(cx.listener(Self::terminal_wheel))
                .child(self.terminal_render(window, cx))
        });
        let home = is_home.then(|| self.home_render(window, cx));
        // Connection messages can wrap; retain the scroll owner instead of
        // imposing the upstream status bar's fixed single-line height.
        let context = super::design::palette(&theme)
            .status_bar()
            .h_auto()
            .px_0()
            .gap_0()
            .id("workspace-context")
            .items_start()
            .min_w_0()
            .w_full()
            .bg(rgb(theme.background))
            .children(
                super::pane_chrome::selected_title(&self.browser_state)
                    .filter(|_| self.developer_mode.enabled)
                    .map(|title| {
                        div()
                            .debug_selector(|| "tmux-selected-title".into())
                            .flex_none()
                            .max_w(px(160.))
                            .px_2()
                            .py_1()
                            .truncate()
                            .text_color(rgb(theme.muted))
                            .child(title)
                    }),
            )
            .child(
                div()
                    .id("connection-status")
                    .debug_selector(|| "tmux-status-viewport".into())
                    .flex_1()
                    .min_w_0()
                    .max_h(px(72.))
                    .overflow_y_scroll()
                    .px_2()
                    .py_1()
                    .text_color(rgb(theme.muted))
                    .child(div().w_full().child(status)),
            );
        // The rounded padding belongs to the terminal surface, so it must
        // use the same default background as the terminal and its headers.
        let content_background = if is_home {
            self.canvas()
        } else {
            theme.background
        };
        let content = super::shell::content_panel(content_background)
            .when(is_home && glass, |panel| {
                panel.bg(rgba((content_background << 8) | 0x99))
            })
            .children(home)
            .when(!is_home, |panel| {
                panel
                    .child(window_strip)
                    .child(self.pane_header_row(window, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .overflow_hidden()
                            .children(terminal),
                    )
                    .child(
                        div()
                            .relative()
                            .flex_none()
                            .w_full()
                            .when(show_status, |footer| footer.child(context))
                            .children(
                                self.pane_actions_panel(window, cx)
                                    .map(|panel| deferred(panel).with_priority(1)),
                            ),
                    )
            });
        let main = div()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .when(show_sidebar, |main| main.child(sidebar))
            .child(
                div()
                    .id("workspace-inset")
                    .debug_selector(|| "tmux-workspace-inset".into())
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .p(px(super::shell::CONTENT_INSET))
                    .child(content),
            );
        let body = div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .text_color(rgb(theme.foreground))
            .on_key_down(cx.listener(Self::picker_key))
            .child(main)
            .children(
                self.picker_popover(window, cx)
                    .map(|popover| deferred(popover).with_priority(2)),
            )
            .children(
                self.machine_dialog(cx)
                    .map(|dialog| deferred(dialog).with_priority(2)),
            )
            .into_any_element();
        super::shell::themed_frame(body, window, &theme, glass, application_tabs)
    }
}

#[cfg(test)]
#[path = "input_interruption_tests.rs"]
mod input_interruption_tests;
