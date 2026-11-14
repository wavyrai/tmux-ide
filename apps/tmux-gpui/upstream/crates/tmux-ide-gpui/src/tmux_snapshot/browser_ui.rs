#[path = "sidebar.rs"]
pub(super) mod sidebar;
pub(super) use sidebar::Keyboard as SidebarKeyboard;
#[path = "browser_select.rs"]
mod select;
#[path = "sidebar_view.rs"]
pub(super) mod sidebar_view;
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
        if self.browser_state.retained_preview || self.resize_gesture.busy() {
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
        let Some(point) = self.terminal_point(event.position) else {
            self.wheel = Default::default();
            return;
        };
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
    fn terminal_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || self.about.is_some()
        {
            return;
        }
        if self.pane_move_key(event, window, cx) {
            return;
        }
        // Let application navigation consume its keys before terminal input forwarding.
        if super::picker::commands::shortcut(&event.keystroke)
            || super::session_history::shortcut(&event.keystroke)
            || super::session_tabs::shortcut(&event.keystroke)
            || sidebar::focus_shortcut(&event.keystroke)
            || super::pane_shortcuts::shortcut(&event.keystroke).is_some()
        {
            return;
        }
        // A reader pane (#756) takes every other key; nothing typed reaches `tmux-ide show`.
        if self.reader_owns_input() {
            self.reader_key(event, window, cx);
            return;
        }
        self.cancel_tab_focus_restore();
        self.cancel_tab_selection_restore();
        // A split's hold takes keys while its stream is re-issued; so does
        // the hold of a reconnect that only just began.
        if (self.browser_state.retained_preview
            && !self.split_hold_waiting()
            && !self.reconnect_hold_takes_keys())
            || (self.resize_gesture.busy() && self.divider.is_none())
        {
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
        if (!self.presence.ready() && !self.focus_reclaim_ready()) || self.frame.is_none() {
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
                match region.text_view(frame.view()) {
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
                                region.valid_view(
                                    frame.view(),
                                    self.browser_state.selected_pane.as_deref(),
                                )
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
        if !self.browser_state.input_ready && !self.pending_input_ready() {
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
        // Fixture timing starts before authority/focus buffering and transport admission.
        let input = super::renderer_probe::runtime::admit(input, &self.browser_state);
        let terminal = matches!(
            input,
            super::keys::Input::Text(_)
                | super::keys::Input::Paste(_)
                | super::keys::Input::Key(_)
                | super::keys::Input::Bytes(_)
        );
        // Only terminal keys may wait in a split's hold; a wheel or scroll
        // during its preview is refused, as before, never sent to the old pane.
        if (self.browser_state.retained_preview
            && !(terminal && (self.split_hold_waiting() || self.reconnect_hold_waiting())))
            || self.resize_gesture.busy()
        {
            super::renderer_probe::runtime::rejected();
            if terminal {
                self.interrupt_input(cx);
            }
            return;
        }
        if terminal && (self.selection.is_some() || self.reader_owns_input()) {
            super::renderer_probe::runtime::rejected();
            return;
        }
        if terminal && !self.offer_terminal_input(cx) {
            super::renderer_probe::runtime::rejected();
            return;
        }
        if terminal && self.pending_input.is_some() {
            self.hold_pending_input(input, cx);
            return;
        }
        let Some(id) = self.browser_state.selected_pane.clone() else {
            return;
        };
        let command = browser::Command::Input {
            input_target: None,
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
            super::renderer_probe::runtime::rejected();
            self.browser_state.input_ready = false;
            self.browser_state.status = "Input queue unavailable — reselect the pane".into();
            cx.notify();
        }
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
        self.reconcile_home_asides(window, cx);
        self.reconcile_sidebar_keyboard(window, cx);
        self.restore_tab_focus(window, cx);
        self.restore_tab_selection();
        self.agent_animation.begin_render(cx.entity_id());
        // GPUI dispatches shortcuts along the focused element path. Initial catalog
        // and selection transitions have no focused control; retain navigation without
        // granting terminal authority or clearing an interrupted-input latch.
        if window.focused(cx).is_none()
            && self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.about.is_none()
        {
            self.terminal_focus.focus(window, cx);
        }
        // About is modal: while it shows, its card keeps the keyboard.
        if let Some(about) = &self.about
            && !about.holds_focus(window)
        {
            about.take_focus(window, cx);
        }
        let theme = self.theme();
        let is_home = self.browser_state.surface == browser::Surface::Home;
        // Home shows the sidebar too, with its Home row selected (#746),
        // while the window leaves Home's table room beside it.
        let show_sidebar = self.sidebar_shown(window);
        // One material backs the header, sidebar and the gutter around opaque content.
        super::design::prepare(&theme, self.chrome.refresh(), cx);
        self.chrome.sync_motion(cx);
        self.chrome.sync(window, cx);
        let bezel = bezel_theme::Theme::of(cx).clone();
        // Its own view, replayed while unchanged (`sidebar_view`).
        let sidebar = self.sidebar_element(window, cx);
        if !show_sidebar {
            self.sidebar_unmounted();
        }
        let status = self.status_line();
        // Routine window navigation must not insert a notice beside the tabs:
        // its width would move the entire strip during every retained frame.
        // Keep failures and developer diagnostics visible without rearming input.
        let quiet_window_transition = self.browser_state.retained_preview
            && self.browser_state.status == "Switching window…"
            && !self.developer_mode.enabled;
        let show_status = !quiet_window_transition
            && super::status_presentation::visible(
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
        if !is_home {
            if let Some(controls) = self.home_filter.as_mut() {
                controls.motion.end();
            }
            self.fleet_view_hidden();
        }
        // Connection messages can wrap; retain the scroll owner instead of
        // imposing the upstream status bar's fixed single-line height.
        let context = bezel
            .status_bar()
            .occlude()
            .h_auto()
            .px_0()
            .gap_0()
            .id("workspace-context")
            .items_start()
            .min_w_0()
            .w_full()
            .bg(if self.developer_mode.enabled {
                bezel.bg
            } else {
                transparent_black()
            })
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
                            .children(super::design::ink_probe(|| "status-title".into()))
                            .child(title)
                    }),
            )
            .child(bezel_ui::scroll::Viewport::new(
                "connection-status",
                div()
                    .id("connection-status")
                    .debug_selector(|| "tmux-status-viewport".into())
                    .flex_1()
                    .min_w_0()
                    .max_h(px(if self.developer_mode.enabled {
                        72.
                    } else {
                        24.
                    }))
                    .px_2()
                    .py_1()
                    .children(super::design::ink_probe(|| "status-text".into()))
                    .child(div().w_full().child(status)),
                Axis::Vertical,
            ));
        // Cards own their terminal background; the surrounding canvas exposes gutters.
        let content_background = self.canvas();
        let mut context = Some(context);
        let notice = if show_status && !self.developer_mode.enabled && !is_home {
            // The notice fades in over FADE_QUICK and leaves at once (#761).
            context.take().map(|notice| {
                bezel_motion::fade_quick("top-row-notice-in", notice).into_any_element()
            })
        } else {
            None
        };
        let (application_tabs, sidebar) = self.top_chrome(sidebar, notice, window, cx);
        let card_border =
            super::pane_cards::render::card_border(&theme, &super::design::palette(&theme));
        let content = super::shell::content_panel(content_background, card_border, is_home)
            .relative()
            .children(home)
            .when(!is_home, |panel| {
                panel
                    .when(
                        self.card_layout(self.input_cell_width.unwrap_or(8.))
                            .is_none(),
                        |panel| panel.child(self.pane_header_row(window, cx)),
                    )
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
                            // Only developer diagnostics occupy a bottom lane.
                            .when(show_status && self.developer_mode.enabled, |footer| {
                                footer.children(context.take())
                            })
                            .children(
                                self.pane_actions_panel(window, cx)
                                    .map(|panel| deferred(panel).with_priority(1)),
                            )
                            .children(
                                self.browser_address_panel(cx)
                                    .map(|panel| deferred(panel).with_priority(2)),
                            ),
                    )
            });
        let main = div()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            // The width snaps, so the terminal grid resizes once; the
            // contents fade in over FADE_QUICK (#761).
            .when(show_sidebar, |main| {
                main.child(self.sidebar_fade_in(sidebar))
            })
            .child(
                div()
                    .id("workspace-inset")
                    .debug_selector(|| "tmux-workspace-inset".into())
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .map(|inset| self.inset_edges(inset, show_sidebar, window))
                    .child(content),
            );
        let body = div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .text_color(bezel.text)
            .children(super::design::ink_probe(|| "workspace-body".into()))
            .on_key_down(cx.listener(Self::picker_key))
            .map(|body| self.menu_actions(body, cx))
            .child(main)
            .children(self.floating_connection_slot(show_sidebar, cx))
            .children(
                self.picker_popover(window, cx)
                    .map(|popover| deferred(popover).with_priority(2)),
            )
            .children(
                self.machine_dialog(cx)
                    .map(|dialog| deferred(dialog).with_priority(2)),
            )
            .children(
                self.about_dialog(cx)
                    .map(|dialog| deferred(dialog).with_priority(3)),
            )
            .into_any_element();
        super::shell::themed_frame(body, window, cx, application_tabs)
    }
}

/// The sidebar's width; the top row's sidebar controls end at its edge.
/// The sidebar's width: the #746 mockup's 252 pt.
pub(super) const SIDEBAR_WIDTH: f32 = 252.;
/// The narrowest window that shows Home's sidebar beside its table.
pub(super) const HOME_SIDEBAR_MIN: f32 = 900.;

impl SnapshotView {
    /// Whether the sidebar shows: unless hidden, and on Home only while the
    /// window leaves Home's table room beside it (#746). The sidebar and the
    /// top row both ask this, so they always agree.
    pub(super) fn sidebar_shown(&self, window: &Window) -> bool {
        !self.sidebar_hidden
            && (self.browser_state.surface != browser::Surface::Home
                || window.viewport_size().width >= px(HOME_SIDEBAR_MIN))
    }
}

/// The keyboard-selected row's ring, laid over the row so focus never
/// changes its size.
pub(super) fn focus_ring(
    row: Stateful<Div>,
    focused: bool,
    bezel: &bezel_theme::Theme,
) -> Stateful<Div> {
    row.when(focused, |row| row.child(ring(bezel)))
}

fn ring(bezel: &bezel_theme::Theme) -> Div {
    div()
        .debug_selector(|| "tmux-sidebar-focus-ring".into())
        .absolute()
        .inset_0()
        .rounded(px(bezel_theme::Theme::control_radius()))
        .border_1()
        .border_color(bezel.ring)
}

#[cfg(test)]
#[path = "browser_chrome_tests.rs"]
mod chrome_tests;
#[cfg(test)]
#[path = "input_interruption_tests.rs"]
mod input_interruption_tests;
