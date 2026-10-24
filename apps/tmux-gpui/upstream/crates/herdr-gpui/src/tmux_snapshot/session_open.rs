//! One follow-up navigation for an exact session or acknowledged session admission.
use super::{SnapshotView, browser, browser_ui::Selection};
use gpui::{Context, Window};

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Intent {
    request: u64,
    target: Target,
}
#[derive(Debug, PartialEq, Eq)]
enum Target {
    Exact(String),
    Admitted,
}
impl Intent {
    pub(super) fn exact(request: u64, session: String) -> Self {
        Self {
            request,
            target: Target::Exact(session),
        }
    }
    pub(super) fn admitted(request: u64) -> Self {
        Self {
            request,
            target: Target::Admitted,
        }
    }
}
impl SnapshotView {
    /// Called by the activation observer for an actual subsequent blur.
    pub(super) fn cancel_session_open(&mut self) {
        self.pending_session_open = None;
    }
    pub(super) fn finish_session_open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(intent) = self.pending_session_open.as_ref() else {
            return;
        };
        if intent.request != self.browser_request
            // A late tab/history admission must not resurrect navigation after blur.
            || (!self.presence.active() && matches!(intent.target, Target::Admitted))
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || self.browser_commands.is_none()
        {
            self.pending_session_open = None;
            return;
        }
        let state = &self.browser_state;
        // An explicit selection may be made before the first activation callback.
        // Its background catalog has no preferred pane. Wait for the catalog tied
        // to acknowledged foreground presence; actual blur cancels via the observer.
        if !self.presence.ready()
            || self.presence.queued_active_revision() != Some(state.presence_revision)
        {
            return;
        }
        if state.request != intent.request || !state.session_catalog_complete {
            return;
        }
        // Consume before queueing: failure, ambiguity, or a later republish never retries.
        let valid_session = state.surface == browser::Surface::Workspace
            && state
                .selected_session
                .as_ref()
                .is_some_and(|session| match &intent.target {
                    Target::Exact(expected) => session == expected,
                    // Only the acknowledged navigation request may supply this session.
                    Target::Admitted => true,
                })
            && state.selected_pane.is_none()
            && (state.frame.is_none() || state.retained_preview)
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
            let restore_focus = self.session_tabs.focus.restore;
            let restore_selection = self.session_tabs.selections.restore;
            self.select(Selection::Pane(pane), window, cx);
            self.session_tabs.focus.restore = restore_focus;
            self.session_tabs.selections.restore = restore_selection;
        }
    }
}
