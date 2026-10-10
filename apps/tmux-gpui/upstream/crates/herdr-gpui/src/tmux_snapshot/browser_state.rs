//! Apply one already-decoded browser mailbox publication on the UI thread.
use super::{SnapshotView, browser};
use gpui::Context;
impl SnapshotView {
    pub(super) fn apply_browser_state(
        &mut self,
        state: Option<browser::State>,
        cx: &mut Context<Self>,
    ) {
        match state {
            Some(state) if state.request == self.browser_request => {
                self.resize_gesture.observe(&state);
                if self
                    .divider
                    .as_ref()
                    .is_some_and(|drag| !drag.compatible(&state))
                {
                    self.divider = None;
                }
                self.presence.acknowledge(state.presence_revision);
                if !state.input_ready {
                    self.discard_composition(cx);
                }
                if self
                    .selection
                    .as_ref()
                    .is_some_and(|selection| !selection.compatible(&state))
                {
                    self.selection = None;
                }
                self.frame = self
                    .selection
                    .as_ref()
                    .map(|selection| selection.frame.clone())
                    .or_else(|| state.frame.clone());
                self.browser_state = state;
            }
            None => {
                self.pending_session_open = None;
                self.discard_composition(cx);
                self.selection = None;
                self.divider = None;
                self.frame = None;
                self.browser_state.status = "Connection unavailable — restart the preview".into();
                self.browser_commands = None;
            }
            _ => {}
        }
        self.refresh_picker(cx);
        self.refresh_pane_actions(cx);
        self.refresh_new_session(cx);
        cx.notify();
    }
}
#[cfg(test)]
mod tests;
