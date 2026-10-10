//! Native rows reuse Herdr sidebar label clipping and themed hover surfaces.
use super::*;
use crate::tmux_snapshot::browser::home_agents::Phase;
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn home_agent_select(
        &mut self,
        request: u64,
        revision: u64,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_commands.is_some()
            && self.presence.ready()
            && self.browser_state.surface == browser::Surface::Home
            && self.browser_request == request
            && self.browser_state.request == request
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
            && self
                .browser_state
                .home_agents
                .as_ref()
                .is_some_and(|r| r.revision == revision && r.available(key))
        {
            self.select(
                Selection::Agent {
                    from_request: request,
                    roster_revision: revision,
                    key: key.into(),
                },
                window,
                cx,
            );
        }
    }
    pub(in crate::tmux_snapshot) fn home_agent_rows(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let roster = self.browser_state.home_agents.as_ref()?;
        let theme = self.theme();
        let request = self.browser_request;
        let revision = roster.revision;
        let heading = match roster.phase {
            Phase::Loading => "Discovering agents…",
            Phase::Unavailable => "Agent observations unavailable",
            Phase::Live | Phase::Partial => "Agents",
        };
        let mut body = div()
            .mt_4()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().font_weight(FontWeight::SEMIBOLD).child(heading))
            .child(div().text_sm().text_color(rgb(theme.muted)).child(format!(
                "{} of {} sessions observed · {} sessions and {} rows omitted",
                roster.observed_sessions,
                roster.total_sessions,
                roster.truncated_sessions,
                roster.truncated_rows
            )));
        if let Some(note) = &roster.note {
            body = body.child(div().min_w_0().child(note.clone()));
        }
        if roster.rows.is_empty() && roster.phase == Phase::Live {
            body = body.child("No observed agents");
        }
        for (index, row) in roster.rows.iter().enumerate() {
            let key = row.key.clone();
            let enabled = self.browser_commands.is_some() && roster.available(&key);
            let mut item = div()
                .id(("tmux-home-agent", index))
                .debug_selector(move || format!("tmux-home-agent-{index}"))
                .min_w_0()
                .w_full()
                .overflow_hidden()
                .flex()
                .items_center()
                .gap_3()
                .p_3()
                .rounded(px(crate::config::corners::PANEL))
                .bg(rgb(theme.surface))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .truncate()
                                .child(crate::sidebar::label_text(&row.name)),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_sm()
                                .text_color(rgb(theme.muted))
                                .child(row.session_label.clone()),
                        ),
                )
                .child(div().flex_none().text_sm().child(format!(
                    "{}{}",
                    if row.attention { "! " } else { "" },
                    row.status.label()
                )))
                .child(
                    div()
                        .flex_none()
                        .text_color(rgb(theme.muted))
                        .child(if enabled { "Open" } else { "Unavailable" }),
                );
            if enabled {
                item = item
                    .cursor_pointer()
                    .hover(move |s| s.bg(rgb(theme.active)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.home_agent_select(request, revision, &key, window, cx);
                    }));
            }
            body = body.child(item);
        }
        Some(body.into_any_element())
    }
}
