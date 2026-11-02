//! Native rows reuse Herdr sidebar label clipping and themed hover surfaces.
use super::*;
use crate::tmux_snapshot::browser::home_agents::Phase;
use bezel_ui::widgets::{Content, Scaffolding};

/// The agent list's height before it scrolls.
const AGENT_LIST_MAX: f32 = 240.;
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
        let bezel = self.home_palette();
        let (hover, muted) = (bezel.element_hover, bezel.text_muted);
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
                    .debug_selector(|| "home-agents-heading".into())
                    .flex()
                    .items_center()
                    .gap(px(SPACE))
                    .text_style(TextStyle::Headline)
                    .when(roster.phase == Phase::Loading, |line| {
                        line.child(
                            div().debug_selector(|| "home-agents-loader".into()).child(
                                bezel_ui::loaders::pulse_loader(
                                    "home-agents-loader",
                                    &bezel,
                                    4.,
                                    bezel_motion::Painter::of(cx),
                                    cx,
                                ),
                            ),
                        )
                    })
                    .child(heading),
            )
            .child(
                div()
                    .text_style(TextStyle::Callout)
                    .text_color(muted)
                    .children(design::ink_probe(|| "home-agent-counts".into()))
                    .child(crate::tmux_snapshot::roster_counts::home(roster)),
            );
        body = body.child(self.home_filter_controls(cx));
        body = body.child(self.home_recovery_controls(cx));
        if let Some(note) = &roster.note {
            body = body.child(div().min_w_0().child(note.clone()));
        }
        if roster.rows.is_empty() && roster.phase == Phase::Live {
            body = body.child(bezel.empty_state(
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
                bezel
                    .empty_state(
                        bezel_ui::icons::Icon::asset("icons/terminal.svg"),
                        "No matching loaded agents",
                        "Clear the search or change the filters to see more agents.",
                    )
                    .id("home-agents-no-matches"),
            );
        }
        // The list is the scroller, so `scroll_to_item` reaches its rows.
        let mut rows = bezel
            .group_box()
            .id("home-agent-list")
            .debug_selector(|| "home-agent-list".into())
            .w_full()
            .min_w_0()
            .max_h(px(AGENT_LIST_MAX));
        for (shown, (index, row)) in roster
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| filter.matches(roster, row, &query))
            .enumerate()
        {
            let key = row.key.clone();
            let enabled = self.browser_commands.is_some() && roster.available(&key);
            let mut item = bezel
                .card_row(shown == 0)
                .id(("tmux-home-agent", index))
                .debug_selector(move || format!("tmux-home-agent-{index}"))
                .flex_none()
                .min_w_0()
                .w_full()
                .overflow_hidden()
                .py(px(8.))
                .bg(
                    if self
                        .home_filter
                        .as_ref()
                        .is_some_and(|c| c.selected.as_deref() == Some(row.key.as_str()))
                    {
                        bezel.card_selected_bg()
                    } else {
                        bezel.card_glass_bg()
                    },
                )
                .child(
                    svg()
                        .path(super::super::pane_chrome::agent_icon_path(
                            row.harness.as_deref(),
                        ))
                        .size(px(18.))
                        .flex_shrink_0()
                        .text_color(bezel.text),
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
                                .text_style(TextStyle::Callout)
                                .text_color(muted)
                                .debug_selector(move || format!("home-agent-context-{index}"))
                                .children(design::ink_probe(move || {
                                    format!("home-agent-context-{index}")
                                }))
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
                        .text_color(muted)
                        .children(design::ink_probe(move || {
                            format!("home-agent-action-{index}")
                        }))
                        .child(if enabled { "Open" } else { "Unavailable" }),
                );
            if enabled {
                item = item
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.home_agent_select(request, revision, &key, window, cx);
                    }));
            }
            rows = rows.child(item);
        }
        if matches == 0 {
            return Some(body.into_any_element());
        }
        let mut viewport = bezel_ui::scroll::Viewport::new("home-agent-list", rows, Axis::Vertical);
        if let Some(controls) = &self.home_filter {
            viewport = viewport.track_scroll(&controls.scroll);
        }
        // A wheel over the list stays in the list, at its ends too; the page
        // scrolls with the pointer off it.
        let list = bezel_ui::scroll::contain_wheel(
            div()
                .id("home-agent-viewport")
                .debug_selector(|| "home-agent-viewport".into())
                .w_full()
                .min_w_0()
                .child(viewport),
            bezel_ui::scroll::Axes::Vertical,
        );
        Some(body.child(list).into_any_element())
    }
}
