//! Exact displayed-session keyboard focus; terminal authority remains independent.
use super::*;
use crate::tmux_snapshot::SnapshotView;

#[derive(Default)]
pub(in crate::tmux_snapshot) struct Keyboard {
    pub(in crate::tmux_snapshot) active: bool,
    pub(in crate::tmux_snapshot::browser_ui) focus: Option<FocusHandle>,
    pub(in crate::tmux_snapshot::browser_ui) selected: Option<Target>,
    pub(in crate::tmux_snapshot::browser_ui) scroll: ScrollHandle,
    pub(super) controls: Option<[FocusHandle; control_focus::CONTROLS]>,
    reveal: reveal::Reveal,
    pub(in crate::tmux_snapshot::browser_ui) request: u64,
    displayed: Vec<Option<Target>>,
}
pub(in crate::tmux_snapshot::browser_ui) fn focus_shortcut(key: &Keystroke) -> bool {
    key.key == "g"
        && key.modifiers.control
        && !key.modifiers.platform
        && !key.modifiers.alt
        && !key.modifiers.shift
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn sidebar_scope_focused(&self, window: &Window) -> bool {
        self.sidebar_keyboard.active
            && self
                .sidebar_keyboard
                .focus
                .as_ref()
                .is_some_and(|focus| focus.is_focused(window))
    }
    pub(in crate::tmux_snapshot) fn focus_sidebar_scope(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.sidebar_keyboard_allowed() {
            return false;
        }
        let current = rows(&self.browser_state);
        if !current.iter().any(|row| row.target.is_some()) {
            return false;
        }
        let state = &mut self.sidebar_keyboard;
        state
            .focus
            .get_or_insert_with(|| cx.focus_handle())
            .focus(window, cx);
        state.active = true;
        state.request = self.browser_request;
        state.selected = current
            .iter()
            .find(|row| row.selected)
            .and_then(|row| row.target.clone());
        state.displayed = current.into_iter().map(|row| row.target).collect();
        true
    }

    pub(in crate::tmux_snapshot) fn sidebar_keyboard_allowed(&self) -> bool {
        self.browser_state.surface == browser::Surface::Workspace
            && !self.sidebar_hidden
            && self.browser_commands.is_some()
            && self.browser_state.request == self.browser_request
            && self.presence.ready()
            && self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.marked.is_empty()
            && self.divider.is_none()
    }
    pub(in crate::tmux_snapshot::browser_ui) fn reconcile_sidebar_keyboard(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let valid = self.sidebar_keyboard_allowed()
            && self.sidebar_keyboard.request == self.browser_request;
        if self.browser_state.surface == browser::Surface::Workspace
            && self.browser_state.request == self.browser_request
            && !self.sidebar_hidden
        {
            self.sidebar_keyboard.reveal.update(
                &rows(&self.browser_state),
                &self.sidebar_keyboard.scroll,
                self.sidebar_keyboard.active && valid,
                window,
                cx,
            );
        }
        if !valid && self.sidebar_keyboard.active {
            self.sidebar_keyboard.active = false;
            self.interrupt_input(cx);
        }
        self.reconcile_sidebar_controls(window, cx);
        let state = &mut self.sidebar_keyboard;
        if !state.active {
            if state.focus.as_ref().is_some_and(|f| f.is_focused(window)) {
                self.terminal_focus.focus(window, cx);
            }
            return;
        }
        let old = state.displayed.iter().position(|id| {
            id.as_ref()
                .is_some_and(|id| Some(id) == state.selected.as_ref())
        });
        state.displayed = rows(&self.browser_state)
            .into_iter()
            .map(|r| r.target)
            .collect();
        // Rebind focus only while painting the same observed agent. The old
        // revision remains ineligible for input until this redraw occurs.
        if let Some(Target::FleetAgent { scope, key, .. }) = &state.selected {
            state.selected = state.displayed.iter().flatten().find(|target| {
                matches!(target, Target::FleetAgent { scope: current_scope, key: current_key, .. }
                    if current_scope == scope && current_key == key)
            }).cloned();
        }
        let next = state.displayed.iter().position(|id| {
            id.as_ref()
                .is_some_and(|id| Some(id) == state.selected.as_ref())
        });
        if next.is_none() {
            state.selected = None;
        }
        if next != old
            && let Some(index) = next
        {
            state.scroll.scroll_to_item(index + 1);
        }
    }
    pub(in crate::tmux_snapshot) fn sidebar_keyboard_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = &event.keystroke;
        if focus_shortcut(key) {
            self.cancel_tab_focus_restore();
            if !event.is_held
                && self.marked.is_empty()
                && self.picker.is_none()
                && self.pane_actions.is_none()
                && self.new_session.is_none()
                && self.presence.ready()
                && self.browser_commands.is_some()
            {
                if self.sidebar_keyboard_allowed() {
                    let state = &mut self.sidebar_keyboard;
                    state
                        .focus
                        .get_or_insert_with(|| cx.focus_handle())
                        .focus(window, cx);
                    state.active = true;
                    state.request = self.browser_request;
                    state.displayed = rows(&self.browser_state)
                        .into_iter()
                        .map(|r| r.target)
                        .collect();
                    state.selected = rows(&self.browser_state)
                        .into_iter()
                        .find(|r| r.selected)
                        .and_then(|r| r.target);
                    if let Some(index) = state.displayed.iter().position(|id| {
                        id.as_ref()
                            .is_some_and(|id| Some(id) == state.selected.as_ref())
                    }) {
                        state.scroll.scroll_to_item(index + 1);
                    }
                    cx.notify();
                } else if self.browser_state.surface == browser::Surface::Home
                    || self.sidebar_hidden
                {
                    self.open_picker(window, cx);
                }
            }
            cx.stop_propagation();
            window.prevent_default();
            return true;
        }
        if self.sidebar_control_key(event, window, cx) {
            return true;
        }
        if !self.sidebar_keyboard.active
            || !self
                .sidebar_keyboard
                .focus
                .as_ref()
                .is_some_and(|f| f.is_focused(window))
        {
            return false;
        }
        if key.modifiers.platform || super::super::super::picker::commands::shortcut(key) {
            return false;
        }
        cx.stop_propagation();
        window.prevent_default();
        if !self.sidebar_keyboard_allowed() || self.sidebar_keyboard.request != self.browser_request
        {
            self.sidebar_keyboard.active = false;
            self.interrupt_input(cx);
            self.terminal_focus.focus(window, cx);
            cx.notify();
            return true;
        }
        // Shift-F10, the context-menu key, opens the focused pane row's menu:
        // the same menu as its … button and a right-click (#746).
        if key.key == "f10"
            && key.modifiers.shift
            && let Some(Target::Pane { id, .. }) = self
                .sidebar_keyboard
                .selected
                .clone()
                .filter(|t| current(&self.browser_state, t))
        {
            if !event.is_held {
                self.open_pane_menu(&id, window, cx);
            }
            return true;
        }
        if key.modifiers.control
            || key.modifiers.platform
            || key.modifiers.alt
            || key.modifiers.shift
        {
            return true;
        }
        if key.key == "escape" {
            self.sidebar_keyboard.active = false;
            self.terminal_focus.focus(window, cx);
            cx.notify();
            return true;
        }
        // Machines and their collapse controls live on Home (#746); left and
        // right are inert here, and f toggles the focused session's star.
        if matches!(key.key.as_str(), "left" | "right" | "f") {
            if event.is_held {
                return true;
            }
            if key.key == "f"
                && let Some(target) = self
                    .sidebar_keyboard
                    .selected
                    .clone()
                    .filter(|t| current(&self.browser_state, t))
                && let Some((Some(action), favorite)) = rows(&self.browser_state)
                    .into_iter()
                    .find(|r| r.target.as_ref() == Some(&target))
                    .and_then(|r| r.favorite)
                && let Some(revision) = self
                    .browser_state
                    .fleet
                    .as_ref()
                    .and_then(|f| f.preferences.as_ref())
                    .map(|p| p.revision)
            {
                self.change_fleet_preference(
                    self.browser_request,
                    revision,
                    &action,
                    !favorite,
                    cx,
                );
            }
            return true;
        }
        let state = &mut self.sidebar_keyboard;
        if state
            .selected
            .as_ref()
            .is_some_and(|id| !current(&self.browser_state, id))
        {
            state.selected = None;
        }
        if matches!(key.key.as_str(), "enter" | "return") {
            if event.is_held {
                return true;
            }
            if let Some(id) = state
                .selected
                .clone()
                .filter(|id| state.displayed.contains(&Some(id.clone())))
            {
                let request = state.request;
                self.select_sidebar(request, &id, window, cx);
            }
            return true;
        }
        // Only rows already painted may receive keyboard focus; a refresh cannot invent a replacement.
        let rows: Vec<_> = state
            .displayed
            .iter()
            .flatten()
            .filter(|id| current(&self.browser_state, id))
            .cloned()
            .collect();
        if rows.is_empty() {
            return true;
        }
        let current = rows
            .iter()
            .position(|id| Some(id) == state.selected.as_ref());
        let page = state
            .scroll
            .bottom_item()
            .saturating_sub(state.scroll.top_item())
            .max(1);
        let index = match key.key.as_str() {
            "up" => current.unwrap_or(0).saturating_sub(1),
            "down" => current.map_or(0, |index| (index + 1).min(rows.len() - 1)),
            "pageup" => current.unwrap_or(0).saturating_sub(page),
            "pagedown" => current.map_or(0, |index| (index + page).min(rows.len() - 1)),
            "home" => 0,
            "end" => rows.len() - 1,
            _ => return true,
        };
        state.selected = Some(rows[index].clone());
        if let Some(index) = state.displayed.iter().position(|id| {
            id.as_ref()
                .is_some_and(|id| Some(id) == state.selected.as_ref())
        }) {
            state.scroll.scroll_to_item(index + 1);
        }
        cx.notify();
        true
    }
}
