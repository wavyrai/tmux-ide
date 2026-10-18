//! Apply one already-decoded browser mailbox publication on the UI thread.
use super::{SnapshotView, browser};
use gpui::Context;
impl SnapshotView {
    pub(super) fn apply_browser_state(
        &mut self,
        state: Option<browser::State>,
        cx: &mut Context<Self>,
    ) {
        if let Some(state) = &state {
            self.accept_session_tabs_state(state, cx);
            self.accept_workspace_fleet_agent_state(state, cx);
            self.accept_session_history_state(state, cx);
            self.accept_attention_state(state);
            self.accept_palette_state(state);
        }
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
                self.workspace_fleet_agents.pending = None;
                self.session_history.pending = None;
                self.session_tabs.pending = None;
                self.attention.pending = None;
                self.palette.pending = None;
                self.cancel_palette();
                self.cancel_attention();
                self.pending_session_open = None;
                self.discard_composition(cx);
                self.selection = None;
                self.divider = None;
                self.frame = None;
                self.browser_state.retained_preview = false;
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
