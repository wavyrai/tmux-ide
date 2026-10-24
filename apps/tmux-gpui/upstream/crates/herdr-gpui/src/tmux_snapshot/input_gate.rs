//! An interrupted terminal gesture must never resume with only its suffix.
use super::SnapshotView;
use gpui::Context;
impl SnapshotView {
    pub(super) fn terminal_input_ready(&self) -> bool {
        !self.browser_state.input_target_rejected
            && self.divider.is_none()
            && !self.resize_gesture.busy()
            && !self.browser_state.retained_preview
            && self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.presence.ready()
            && self.session_tabs.pending.is_none()
            && self.browser_state.input_ready
            && self.frame.is_some()
            && self.browser_state.selected_pane.is_some()
    }
    pub(super) fn historical_selection_ready(&self) -> bool {
        !self.browser_state.retained_preview
            && self.divider.is_none()
            && !self.resize_gesture.busy()
            && self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.presence.ready()
            && self.browser_commands.is_some()
            && self.browser_state.request == self.browser_request
            && self.browser_state.surface == super::browser::Surface::Workspace
            && self.browser_state.history_offset > 0
            && !self.browser_state.input_ready
            && self
                .frame
                .as_ref()
                .zip(self.browser_state.frame.as_ref())
                .is_some_and(|(paint, current)| paint.same(current))
            && self.browser_state.selected_pane.is_some()
    }
    pub(super) fn interrupt_input(&mut self, cx: &mut Context<Self>) {
        self.pending_input = None;
        self.cancel_pointer();
        self.input_interrupted = true;
        self.discard_composition(cx);
        cx.notify();
    }
    pub(super) fn offer_terminal_input(&mut self, cx: &mut Context<Self>) -> bool {
        if self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some() {
            return false;
        }
        if self.divider.is_some() || self.resize_gesture.busy() {
            self.interrupt_input(cx);
            return false;
        }
        self.expire_pending_input(cx);
        if !self.terminal_input_ready() && !self.pending_input_ready() {
            self.interrupt_input(cx);
        }
        // Only a current, ready terminal click clears this local latch. Publications,
        // target changes and activation never turn an interrupted command into input.
        !self.input_interrupted
    }
}
