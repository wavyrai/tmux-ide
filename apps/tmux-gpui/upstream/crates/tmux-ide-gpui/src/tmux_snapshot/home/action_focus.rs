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
        let card = self.whats_new_focused(window);
        match event.keystroke.key.as_str() {
            "tab" if selected.is_some() || card || self.terminal_focus.is_focused(window) => {
                self.prepare_home_filter(cx);
                let Some(controls) = &self.home_filter else {
                    return false;
                };
                // Slot 1 was Theme, which left the action row (#746).
                let mut order: Vec<FocusHandle> = (0..5)
                    .filter(|&slot| {
                        !((slot < 4 && self.browser_commands.is_none())
                            || (slot == 4 && !self.home_diagnostics_available())
                            || slot == 1
                            || (slot == 3 && !self.local_session_available()))
                    })
                    .map(|slot| controls.actions[slot].clone())
                    .collect();
                // The What's new card's buttons follow Home's own.
                order.extend(self.whats_new_stops(cx).into_iter().flatten());
                if order.is_empty() {
                    return false;
                }
                let at = order.iter().position(|focus| focus.is_focused(window));
                let next = match (at, event.keystroke.modifiers.shift) {
                    (None, false) => 0,
                    (None, true) => order.len() - 1,
                    (Some(i), false) => (i + 1) % order.len(),
                    (Some(i), true) => (i + order.len() - 1) % order.len(),
                };
                order[next].focus(window, cx);
            }
            "escape" if selected.is_some() => self.terminal_focus.focus(window, cx),
            // Escape closes the What's new card from the card or from Home.
            "escape" if card || self.terminal_focus.is_focused(window) => {
                if self.whats_new_stops(cx).is_none() {
                    return false;
                }
                self.close_whats_new(cx);
                self.terminal_focus.focus(window, cx);
            }
            _ => return false,
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
        true
    }
}
