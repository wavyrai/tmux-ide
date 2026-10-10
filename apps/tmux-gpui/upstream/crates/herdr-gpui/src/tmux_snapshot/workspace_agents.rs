//! Selected-workspace agent navigation uses the same Herdr-derived sidebar rows.
use super::*;
use crate::tmux_snapshot::browser::home_agents::Phase;
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
    pub(in crate::tmux_snapshot) fn workspace_agent_rows(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.browser_state.surface != browser::Surface::Workspace {
            return None;
        }
        let w = self.browser_state.workspace_agents.as_ref()?;
        if self.browser_state.selected_session.as_ref() != Some(&w.session_id) {
            return None;
        }
        let theme = self.theme();
        let request = self.browser_request;
        let revision = w.roster.revision;
        let mut body = div()
            .debug_selector(|| "tmux-workspace-agents-section".into())
            .flex_shrink_0()
            .mt_3()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_1()
            .overflow_hidden()
            .child(
                div()
                    .px_2()
                    .text_sm()
                    .text_color(rgb(theme.muted))
                    .child("Agents"),
            );
        let phase = match w.roster.phase {
            Phase::Loading => Some("Refreshing agents…"),
            Phase::Unavailable => Some("Agent observations unavailable"),
            _ => None,
        };
        if let Some(text) = phase {
            body = body.child(div().px_2().text_sm().child(text));
        }
        if let Some(note) = &w.roster.note {
            body = body.child(div().px_2().text_sm().child(note.clone()));
        }
        if w.roster.truncated_rows > 0 {
            body = body.child(
                div()
                    .px_2()
                    .text_sm()
                    .child(format!("{} agents omitted", w.roster.truncated_rows)),
            );
        }
        for (index, agent) in w.roster.rows.iter().enumerate() {
            let key = agent.key.clone();
            let session = w.session_id.clone();
            let enabled = self.browser_commands.is_some() && w.roster.available(&key);
            let row = sidebar::Row {
                label: agent.name.clone(),
                pane_count: None,
                selected: agent.pane_id.is_some()
                    && agent.pane_id == self.browser_state.selected_pane,
                target: None,
            };
            let mut element = sidebar::render_row(512 + index, &row, &theme, self.accent(), false)
                .debug_selector(move || format!("tmux-workspace-agent-{index}"))
                .child(
                    div()
                        .flex_none()
                        .text_xs()
                        .text_color(rgb(theme.muted))
                        .child(format!(
                            "{}{}",
                            if agent.attention { "!" } else { "" },
                            agent.status.label()
                        )),
                );
            if enabled {
                element =
                    element
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.workspace_agent_select(
                                request, revision, &session, &key, window, cx,
                            );
                        }));
            }
            body = body.child(element);
        }
        Some(body.into_any_element())
    }
}
