//! Keyboard admission for Home's action row only, never terminal Tab input.
use super::*;

pub(super) fn focus_control(
    control: Stateful<Div>,
    focus: &FocusHandle,
    index: isize,
    color: u32,
    _background: u32,
) -> Stateful<Div> {
    control
        .border_1()
        .border_color(transparent_black())
        .track_focus(focus)
        .tab_index(index)
        .focus_visible(move |style| style.border_color(rgb(color)))
}

impl SnapshotView {
    pub(super) fn home_copy_diagnostics(
        &mut self,
        request: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.home_diagnostics_available()
            || self.browser_request != request
            || self.browser_state.request != request
            || self.picker.is_some()
        {
            return;
        }
        self.copy_diagnostics(window, cx);
    }

    pub(in crate::tmux_snapshot) fn home_diagnostics_available(&self) -> bool {
        self.browser_state.surface == browser::Surface::Home
            && (self.browser_commands.is_none()
                || self.browser_state.home_phase == browser::HomePhase::Unavailable
                || self.browser_state.local_setup.is_some())
    }

    pub(in crate::tmux_snapshot) fn home_action_index(&self, window: &Window) -> Option<usize> {
        if self.browser_state.surface != browser::Surface::Home {
            return None;
        }
        self.home_filter
            .as_ref()?
            .actions
            .iter()
            .position(|focus| focus.is_focused(window))
    }

    pub(super) fn home_action_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.browser_state.surface != browser::Surface::Home
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || event.keystroke.modifiers.platform
            || event.keystroke.modifiers.control
            || event.keystroke.modifiers.alt
        {
            return false;
        }
        let selected = self.home_action_index(window);
        match event.keystroke.key.as_str() {
            "tab" if selected.is_some() || self.terminal_focus.is_focused(window) => {
                self.prepare_home_filter(cx);
                if let Some(controls) = &self.home_filter {
                    let mut next = match (selected, event.keystroke.modifiers.shift) {
                        (None, false) => 0,
                        (None, true) => 4,
                        (Some(index), false) => (index + 1) % 5,
                        (Some(index), true) => (index + 4) % 5,
                    };
                    while (next < 4 && self.browser_commands.is_none())
                        || (next == 4 && !self.home_diagnostics_available())
                        || (next == 1 && self.browser_state.appearance.is_none())
                        || (next == 3 && !self.local_session_available())
                    {
                        next = if event.keystroke.modifiers.shift {
                            (next + 4) % 5
                        } else {
                            (next + 1) % 5
                        };
                    }
                    controls.actions[next].focus(window, cx);
                }
            }
            "escape" if selected.is_some() => self.terminal_focus.focus(window, cx),
            _ => return false,
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
        true
    }
}
