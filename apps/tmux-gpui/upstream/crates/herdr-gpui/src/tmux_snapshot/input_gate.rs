//! An interrupted terminal gesture must never resume with only its suffix.
use super::SnapshotView;
use gpui::Context;
impl SnapshotView {
    pub(super) fn terminal_input_ready(&self) -> bool {
        self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.presence.ready()
            && self.browser_state.input_ready
            && self.frame.is_some()
            && self.browser_state.selected_pane.is_some()
    }
    pub(super) fn interrupt_input(&mut self, cx: &mut Context<Self>) {
        self.input_interrupted = true;
        self.discard_composition(cx);
        cx.notify();
    }
    pub(super) fn offer_terminal_input(&mut self, cx: &mut Context<Self>) -> bool {
        if self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some() {
            return false;
        }
        if self.divider.is_some() {
            self.interrupt_input(cx);
            return false;
        }
        if !self.terminal_input_ready() {
            self.interrupt_input(cx);
        }
        // Only a current, ready terminal click clears this local latch. Publications,
        // target changes and activation never turn an interrupted command into input.
        !self.input_interrupted
    }
}
