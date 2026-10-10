//! One follow-up navigation for an explicit native session-open action.
use super::{SnapshotView, browser, browser_ui::Selection};
use gpui::{Context, Window};

impl SnapshotView {
    pub(super) fn finish_session_open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((request, session)) = self.pending_session_open.as_ref() else {
            return;
        };
        if *request != self.browser_request
            || !self.presence.active()
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || self.browser_commands.is_none()
        {
            self.pending_session_open = None;
            return;
        }
        let state = &self.browser_state;
        if state.request != *request || !state.session_catalog_complete {
            return;
        }
        // Consume before queueing: failure, ambiguity, or a later republish never retries.
        let valid_session = state.surface == browser::Surface::Workspace
            && state.selected_session.as_ref() == Some(session)
            && state.selected_pane.is_none()
            && state.frame.is_none()
            && !state.input_ready;
        let pane = valid_session
            .then(|| state.preferred_pane.clone())
            .flatten()
            .filter(|id| {
                state
                    .panes
                    .iter()
                    .any(|pane| &pane.id == id && pane.window_id.is_some())
            });
        self.pending_session_open = None;
        if let Some(pane) = pane {
            self.select(Selection::Pane(pane), window, cx);
        }
    }
}
