#[path = "sidebar.rs"]
mod sidebar;
#[path = "workspace_agents.rs"]
mod workspace_agents;
use super::{SnapshotView, browser};
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
    Refresh,
    Session(String),
    Pane(String),
}
impl SnapshotView {
    fn terminal_click(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some() {
            return;
        }
        if self.begin_divider(event.position, cx) {
            return;
        }
        if self.selection.is_some() {
            self.clear_selection(cx);
        }
        if !self.terminal_input_ready() {
            self.interrupt_input(cx);
            // Keep keydown observable even before AppKit text input is installed.
            self.terminal_focus.focus(window, cx);
            return;
        }
        if !super::hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref()) {
            return;
        }
        let (Some((bounds, _)), Some(width)) = (self.input_geometry, self.input_cell_width) else {
            return;
        };
        if !bounds.contains(&event.position) {
            return;
        }
        let point = event.position - bounds.origin;
        let id = super::hit_regions::hit(
            &self.browser_state.regions,
            f32::from(point.x),
            f32::from(point.y),
            width,
            crate::terminal::CELL_HEIGHT,
        )
        .map(str::to_owned);
        if let Some(id) = id {
            if self.browser_state.selected_pane.as_ref() != Some(&id) {
                self.select(Selection::Pane(id), window, cx);
            } else {
                self.input_interrupted = false;
                self.discard_composition(cx);
                self.selection = super::selection::Capture::begin(
                    &self.browser_state,
                    f32::from(point.x) / width,
                    f32::from(point.y) / crate::terminal::CELL_HEIGHT,
                );
                cx.notify();
            }
            self.terminal_focus.focus(window, cx);
        }
    }
    pub(super) fn clear_selection(&mut self, cx: &mut Context<Self>) {
        if self.selection.take().is_some() {
            self.frame = self.browser_state.frame.clone();
            cx.notify();
        }
    }
    fn terminal_drag(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.divider.is_some() {
            if event.pressed_button != Some(MouseButton::Left) {
                self.divider = None;
            } else {
                self.move_divider(event.position, false, cx);
            }
            cx.stop_propagation();
            return;
        }
        if event.pressed_button != Some(MouseButton::Left) {
            if let Some(selection) = &mut self.selection {
                selection.dragging = false;
            }
            return;
        }
        self.update_drag(event.position, cx);
    }
    fn update_drag(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let (Some(selection), Some((bounds, _)), Some(width)) = (
            &mut self.selection,
            self.input_geometry,
            self.input_cell_width,
        ) else {
            return;
        };
        if !selection.dragging {
            return;
        }
        let point = position - bounds.origin;
        if selection
            .update(
                f32::from(point.x) / width,
                f32::from(point.y) / crate::terminal::CELL_HEIGHT,
            )
            .is_err()
        {
            self.clear_selection(cx);
        }
        cx.notify();
        cx.stop_propagation();
    }
    fn terminal_release(
        &mut self,
        event: &MouseUpEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.divider.is_some() {
            self.move_divider(event.position, true, cx);
            cx.stop_propagation();
            return;
        }
        self.update_drag(event.position, cx);
        if let Some(selection) = &mut self.selection {
            selection.dragging = false;
        }
        if self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.empty())
        {
            self.clear_selection(cx);
        }
        cx.notify();
    }
    fn terminal_wheel(
        &mut self,
        event: &ScrollWheelEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
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
            crate::terminal::CELL_HEIGHT,
        );
        if !bounds.contains(&event.position)
            || target != self.browser_state.selected_pane.as_deref()
            || target.is_none()
        {
            self.wheel = Default::default();
            return;
        }
        if matches!(event.touch_phase, TouchPhase::Started) {
            self.wheel = Default::default();
        }
        let delta = match event.delta {
            ScrollDelta::Pixels(p) => f32::from(p.y) / crate::terminal::CELL_HEIGHT,
            ScrollDelta::Lines(p) => p.y,
        };
        let lines = self.wheel.add(delta);
        if lines != 0 {
            self.discard_composition(cx);
            self.queue_input(super::keys::Input::Scroll(lines), cx);
        }
        cx.stop_propagation();
    }
    fn terminal_key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some() {
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
            let rows = self
                .frame
                .as_ref()
                .map_or(1, |f| f.height.saturating_sub(1).min(1000)) as i16;
            let scroll = match key.key.as_str() {
                "pageup" => Some(rows),
                "pagedown" => Some(-rows),
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
        self.divider = None;
        self.picker = None;
        self.pane_actions = None;
        self.new_session = None;
        self.pending_session_open = None;
        let opening_session = match &selection {
            Selection::Session(id) => Some(id.clone()),
            _ => None,
        };
        self.new_session_queued = None;
        self.clear_selection(cx);
        self.wheel = Default::default();
        window.blur(cx);
        self.discard_composition(cx);
        let Some(request) = self.browser_request.checked_add(1) else {
            return;
        };
        let going_home = matches!(selection, Selection::Home | Selection::Refresh);
        let selecting_pane = matches!(selection, Selection::Pane(_));
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
            Selection::Pane(id) => browser::Command::Pane { request, id },
            Selection::Home => browser::Command::Home { request },
            Selection::Refresh => browser::Command::Refresh { request },
        };
        if self
            .browser_commands
            .as_ref()
            .is_some_and(|s| s.try_send(command).is_ok())
        {
            self.browser_request = request;
            self.pending_session_open = opening_session.map(|id| (request, id));
            self.frame = None;
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
            || self.browser_commands.is_none()
            || !sidebar::current(&self.browser_state, target)
        {
            return;
        }
        self.select(
            match target {
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
        let show_sidebar = !is_home || self.picker.is_some();
        let viewport = window.viewport_size();
        let chrome_height =
            crate::titlebar::HEIGHT + super::workspace_chrome::APPLICATION_TABS_HEIGHT;
        let glass = self.glass.sync(
            window,
            Bounds::new(
                point(px(0.), px(chrome_height)),
                size(
                    if show_sidebar {
                        px(224.).min(viewport.width)
                    } else {
                        px(0.)
                    },
                    (viewport.height - px(chrome_height)).max(px(0.)),
                ),
            ),
            theme.surface,
        );
        let mut sidebar = div()
            .id("session-list")
            .w(px(224.))
            .h_full()
            .overflow_y_scroll()
            .flex_shrink_0()
            .p_2()
            .bg(super::shell::sidebar_fill(theme.surface, glass))
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .px_2()
                    .pt_3()
                    .pb_1()
                    .text_color(rgb(theme.muted))
                    .child("Sessions"),
            );
        let request = self.browser_request;
        for (index, row) in sidebar::rows(&self.browser_state).into_iter().enumerate() {
            let mut element = sidebar::render_row(index, &row, &theme, self.accent(), glass);
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
        sidebar = sidebar.children(self.workspace_agent_rows(cx));
        sidebar = sidebar.child(div().flex_1()).child(
            div()
                .flex()
                .gap_2()
                .px_2()
                .py_2()
                .child(
                    div()
                        .id("open-picker")
                        .cursor_pointer()
                        .child("Switch…")
                        .on_click(cx.listener(|view, _, window, cx| view.open_picker(window, cx))),
                )
                .child(
                    div()
                        .id("open-theme-picker")
                        .cursor_pointer()
                        .child("Theme…")
                        .on_click(
                            cx.listener(|view, _, window, cx| view.open_theme_picker(window, cx)),
                        ),
                )
                .child(
                    div()
                        .id("refresh-sessions")
                        .cursor_pointer()
                        .child("↻")
                        .on_click(cx.listener(|view, _, window, cx| {
                            view.select(Selection::Refresh, window, cx)
                        })),
                ),
        );
        let application_tabs = self.application_tabs(window, cx);
        let window_strip = self.workspace_window_strip(window, cx);
        let status = if self.selection.is_some() {
            "Selecting captured frame — Cmd-C copies; Escape or click resumes".into()
        } else if self.input_interrupted {
            format!(
                "Input interrupted; click terminal when ready, then retype — {}",
                self.browser_state.status
            )
        } else {
            self.browser_state.status.clone()
        };
        let terminal = (self.browser_state.surface != browser::Surface::Home).then(|| {
            div()
                .size_full()
                .track_focus(&self.terminal_focus)
                .on_mouse_down(MouseButton::Left, cx.listener(Self::terminal_click))
                .on_mouse_move(cx.listener(Self::terminal_drag))
                .on_mouse_up(MouseButton::Left, cx.listener(Self::terminal_release))
                .on_mouse_up_out(MouseButton::Left, cx.listener(Self::terminal_release))
                .on_key_down(cx.listener(Self::terminal_key))
                .on_scroll_wheel(cx.listener(Self::terminal_wheel))
                .child(self.terminal_render(window, cx))
        });
        if self.picker.is_some() {
            sidebar = div()
                .id("picker-sidebar")
                .w(px(224.))
                .h_full()
                .flex_shrink_0()
                .p_2()
                .overflow_hidden()
                .child(self.picker_render(cx));
        }
        let home = is_home.then(|| self.home_render(window, cx));
        let heading = if is_home {
            "Home".to_owned()
        } else {
            self.browser_state
                .sessions
                .iter()
                .find(|session| Some(&session.id) == self.browser_state.selected_session.as_ref())
                .map(|session| session.label.clone())
                .unwrap_or_else(|| "Session".into())
        };
        let context = div()
            .id("workspace-context")
            .flex()
            .items_start()
            .flex_none()
            .min_w_0()
            .w_full()
            .bg(rgb(theme.surface))
            .border_t_1()
            .border_color(rgb(theme.active))
            .child(self.pane_actions_button(cx))
            .children(
                super::pane_chrome::selected_title(&self.browser_state).map(|title| {
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
        let main = div()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .when(show_sidebar, |main| main.child(sidebar))
            .children(home)
            .when(!is_home, |main| {
                main.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .bg(rgb(self.canvas()))
                        .flex()
                        .flex_col()
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
                                .child(context)
                                .children(
                                    self.pane_actions_panel(cx)
                                        .map(|panel| deferred(panel).with_priority(1)),
                                ),
                        ),
                )
            });
        let body = div()
            .size_full()
            .flex()
            .flex_col()
            .when(!glass, |body| body.bg(rgb(self.canvas())))
            .text_color(rgb(theme.foreground))
            .on_key_down(cx.listener(Self::picker_key))
            .child(application_tabs)
            .child(main)
            .into_any_element();
        super::shell::themed_frame(body, window, &theme, self.canvas(), glass, heading)
    }
}

#[cfg(test)]
#[path = "input_interruption_tests.rs"]
mod input_interruption_tests;
