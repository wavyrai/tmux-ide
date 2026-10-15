//! Opt-in chrome traversal belongs to Ctrl+G, never the terminal Tab key.
use super::*;
use crate::tmux_snapshot::{SnapshotView, pane_actions};

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn sidebar_footer_current(&self, request: u64) -> bool {
        // Recovery clicks remain available while terminal presence is pending.
        self.browser_state.surface == browser::Surface::Workspace
            && !self.sidebar_hidden
            && self.browser_commands.is_some()
            && self.browser_request == request
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
            && self.marked.is_empty()
            && self.divider.is_none()
    }

    fn sidebar_control_available(&self, index: usize) -> bool {
        match index {
            1 => self.browser_state.appearance.is_some(),
            4 => {
                pane_actions::Target::capture(&self.browser_state).is_some()
                    && self.browser_state.selected_session.is_some()
            }
            _ => true,
        }
    }

    fn sidebar_control_index(&self, window: &Window) -> Option<usize> {
        self.sidebar_keyboard
            .controls
            .as_ref()?
            .iter()
            .position(|focus| focus.is_focused(window))
    }

    pub(super) fn reconcile_sidebar_controls(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focused = self.sidebar_control_index(window);
        let valid = self.sidebar_keyboard.active
            && self.sidebar_keyboard_allowed()
            && self.sidebar_keyboard.request == self.browser_request;
        if !valid {
            if focused.is_some() {
                self.terminal_focus.focus(window, cx);
            }
            return;
        }
        self.sidebar_keyboard
            .controls
            .get_or_insert_with(|| std::array::from_fn(|_| cx.focus_handle()));
        if focused.is_some_and(|index| !self.sidebar_control_available(index))
            && let Some(focus) = &self.sidebar_keyboard.focus
        {
            focus.focus(window, cx);
        }
    }

    pub(in crate::tmux_snapshot) fn sidebar_focus_control(
        &self,
        control: Stateful<Div>,
        index: usize,
        theme: &Theme,
    ) -> Stateful<Div> {
        if !self.sidebar_keyboard.active
            || !self.sidebar_keyboard_allowed()
            || self.sidebar_keyboard.request != self.browser_request
            || !self.sidebar_control_available(index)
        {
            return control;
        }
        let Some(handles) = &self.sidebar_keyboard.controls else {
            return control;
        };
        let color = theme.ink(theme.primary());
        let background = theme.surface;
        control
            .track_focus(&handles[index])
            .tab_index(index as isize)
            .focus_visible(move |style| {
                style.bg(rgb(background)).shadow(vec![BoxShadow {
                    color: rgb(color).into(),
                    offset: point(px(0.), px(0.)),
                    blur_radius: px(0.),
                    spread_radius: px(2.),
                    inset: false,
                }])
            })
    }

    pub(super) fn sidebar_control_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let focused = self.sidebar_control_index(window);
        let row_focused = self
            .sidebar_keyboard
            .focus
            .as_ref()
            .is_some_and(|f| f.is_focused(window));
        if !self.sidebar_keyboard.active || (focused.is_none() && !row_focused) {
            return false;
        }
        let key = &event.keystroke;
        if key.modifiers.platform || super::super::super::picker::commands::shortcut(key) {
            return false;
        }
        if !self.sidebar_keyboard_allowed() || self.sidebar_keyboard.request != self.browser_request
        {
            self.sidebar_keyboard.active = false;
            self.interrupt_input(cx);
            self.terminal_focus.focus(window, cx);
        } else if key.key == "tab" && !key.modifiers.control && !key.modifiers.alt {
            self.sidebar_keyboard
                .controls
                .get_or_insert_with(|| std::array::from_fn(|_| cx.focus_handle()));
            let mut order = vec![None];
            order.extend(
                (0..5)
                    .filter(|i| self.sidebar_control_available(*i))
                    .map(Some),
            );
            let current = order.iter().position(|slot| *slot == focused).unwrap_or(0);
            let next = if key.modifiers.shift {
                (current + order.len() - 1) % order.len()
            } else {
                (current + 1) % order.len()
            };
            if let Some(index) = order[next] {
                if let Some(handles) = &self.sidebar_keyboard.controls {
                    handles[index].focus(window, cx);
                }
            } else if let Some(focus) = &self.sidebar_keyboard.focus {
                focus.focus(window, cx);
            }
        } else if focused.is_some() && key.key == "escape" {
            self.sidebar_keyboard.active = false;
            self.terminal_focus.focus(window, cx);
        } else {
            // Button Enter/Space must retain GPUI's key-up activation. Returning
            // early also prevents the selected session row consuming Enter.
            return focused.is_some();
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
        true
    }
}
