//! Native rows reuse Herdr sidebar label clipping and themed hover surfaces.
use super::*;
use crate::tmux_snapshot::browser::home_agents::Phase;
use bezel_ui::widgets::Content;
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
        let query = self
            .home_filter
            .as_ref()
            .map_or_else(String::new, |c| c.search.read(cx).text().to_owned());
        let filter = self
            .home_filter
            .as_ref()
            .map_or(filters::Filter::All, |c| c.filter);
        let matches = roster
            .rows
            .iter()
            .filter(|row| filter.matches(roster, row, &query))
            .count();
        let heading = match roster.phase {
            Phase::Loading => "Discovering agents…",
            Phase::Unavailable => "Agent observations unavailable",
            Phase::Live | Phase::Partial => "Agents",
        };
        let mut body = div()
            .pt(px(6.))
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(heading),
            )
            .child(div().text_sm().text_color(rgb(theme.muted)).child(format!(
                "{} of {} sessions observed{}",
                roster.observed_sessions,
                roster.total_sessions,
                if roster.truncated_sessions > 0 || roster.truncated_rows > 0 {
                    format!(
                        " · {} sessions and {} rows omitted",
                        roster.truncated_sessions, roster.truncated_rows
                    )
                } else {
                    String::new()
                }
            )));
        body = body.child(self.home_filter_controls(cx));
        body = body.child(self.home_recovery_controls(cx));
        if let Some(note) = &roster.note {
            body = body.child(div().min_w_0().child(note.clone()));
        }
        if roster.rows.is_empty() && roster.phase == Phase::Live {
            body = body.child(super::super::design::palette(&theme).empty_state(
                bezel_ui::icons::Icon::asset("icons/terminal.svg"),
                "No observed agents",
                "Start a coding agent in a terminal to see its activity here.",
            ));
        }
        if !roster.rows.is_empty()
            && matches == 0
            && matches!(roster.phase, Phase::Live | Phase::Partial)
        {
            body = body.child(
                super::super::design::palette(&theme)
                    .empty_state(
                        bezel_ui::icons::Icon::asset("icons/terminal.svg"),
                        "No matching loaded agents",
                        "Clear the search or change the filters to see more agents.",
                    )
                    .id("home-agents-no-matches"),
            );
        }
        let mut rows = div()
            .id("home-agent-list")
            .w_full()
            .min_w_0()
            .max_h(px(240.))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2()
            .when_some(self.home_filter.as_ref(), |element, controls| {
                element.track_scroll(&controls.scroll)
            });
        for (index, row) in roster
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| filter.matches(roster, row, &query))
        {
            let key = row.key.clone();
            let enabled = self.browser_commands.is_some() && roster.available(&key);
            let mut item = div()
                .id(("tmux-home-agent", index))
                .debug_selector(move || format!("tmux-home-agent-{index}"))
                .flex_none()
                .min_w_0()
                .w_full()
                .overflow_hidden()
                .flex()
                .items_center()
                .gap_3()
                .p_3()
                .rounded(px(crate::config::corners::PANEL))
                .bg(rgb(
                    if self
                        .home_filter
                        .as_ref()
                        .is_some_and(|c| c.selected.as_deref() == Some(row.key.as_str()))
                    {
                        theme.active
                    } else {
                        theme.surface
                    },
                ))
                .child(
                    svg()
                        .path(super::super::pane_chrome::agent_icon_path(
                            row.harness.as_deref(),
                        ))
                        .size(px(18.))
                        .flex_shrink_0()
                        .text_color(rgb(theme.foreground)),
                )
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
                                .debug_selector(move || format!("home-agent-context-{index}"))
                                .child(row.context_label()),
                        ),
                )
                .child(self.agent_indicator(
                    row,
                    !row.available || !matches!(roster.phase, Phase::Live | Phase::Partial),
                ))
                .child(
                    div()
                        .debug_selector(move || format!("home-agent-action-{index}"))
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
            rows = rows.child(item);
        }
        Some(body.child(rows).into_any_element())
    }
}
