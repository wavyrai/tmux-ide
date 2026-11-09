//! Selected-workspace agent navigation (the command palette). The sidebar lists
//! the open session's agents as pane rows (#746).
use super::*;
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn workspace_agent_select(
        &mut self,
        request: u64,
        revision: u64,
        session: &str,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let current = self
            .browser_state
            .workspace_agents
            .as_ref()
            .is_some_and(|w| {
                w.session_id == session && w.roster.revision == revision && w.roster.available(key)
            });
        if current
            && self.browser_commands.is_some()
            && self.presence.ready()
            && self.browser_state.surface == browser::Surface::Workspace
            && self.browser_request == request
            && self.browser_state.request == request
            && self.browser_state.selected_session.as_deref() == Some(session)
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
        {
            self.select(
                Selection::WorkspaceAgent {
                    from_request: request,
                    roster_revision: revision,
                    key: key.into(),
                    session_id: session.into(),
                },
                window,
                cx,
            );
        }
    }
}
