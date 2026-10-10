//! The agents list: every listed host's agents in the panel's one order, so a
//! blocked agent on one host can sit above an idle one on another.

use crate::{
    HerdrWindow, NavigationTarget,
    sidebar::{
        Indicators, agent_name,
        agents::{agent_place, state_label, status_text},
        cell::{AgentRow, Cell, RowContext, RowData, layout_for},
        layout::SidebarLook,
        line_height, tokens, wash,
    },
};
use gpui::{prelude::*, *};

impl HerdrWindow {
    /// Appends a row for each agent `panel_agents` lists, in that order, and
    /// returns the list with how many rows it painted and where the selected
    /// host's focused agent sits among them, for the reveal. A row's host
    /// shapes its own context, as the agent may belong to any listed host.
    pub(super) fn append_agent_rows(
        &self,
        mut list: Stateful<Div>,
        indicators: Indicators,
        look: SidebarLook,
        width: f32,
        cx: &mut Context<Self>,
    ) -> (Stateful<Div>, usize, Option<usize>) {
        let rows = layout_for(self.config.layout.mode);
        let font = &self.config.sidebar;
        let theme = &self.theme;
        let multi = self.endpoints.len() > 1;
        let custom = self.config.usage.inline
            && self.config.sidebar_layout.agents != crate::config::AgentLayout::default();
        let mut count = 0;
        let mut focused = None;
        for (index, agent) in self.panel_agents() {
            let Some(endpoint) = self.endpoints.get(index) else {
                continue;
            };
            let selected = index == self.selected_endpoint;
            let live = if selected { &self.live } else { &endpoint.live };
            let Some(snapshot) = live.snapshot.as_deref() else {
                continue;
            };
            let row_cx = RowContext {
                indicators,
                font,
                theme,
                look,
                width,
                // Agents list under their own heading, not under a host, but
                // each carries its host's colour.
                nest: 0.,
                mark: wash::HostMark::resolve(
                    &self.config.sidebar_style,
                    &endpoint.label,
                    selected,
                    theme,
                ),
                host: (multi && endpoint.id != crate::endpoint::LOCAL)
                    .then_some(endpoint.label.as_str()),
            };
            let lines = if custom {
                let Some(lines) = tokens::agent_rows(
                    &self.config.sidebar_layout.agents,
                    agent,
                    snapshot,
                    row_cx.host,
                ) else {
                    continue;
                };
                lines
            } else {
                Vec::new()
            };
            if selected && agent.focused {
                focused = Some(count);
            }
            let gap = if custom && count > 0 {
                f32::from(self.config.sidebar_layout.agents.row_gap) * line_height(font)
            } else {
                0.
            };
            count += 1;
            let endpoint_id = &endpoint.id;
            let id = agent.pane_id.clone();
            let navigate_endpoint = endpoint_id.clone();
            list = list.child(
                Cell::new(
                    rows,
                    RowData::Agent(AgentRow {
                        key: format!("agent-{id}"),
                        name: agent_name(agent),
                        icon: crate::icons::AgentIcon::from_identity(agent.agent.as_deref()),
                        status: agent.agent_status,
                        place: agent_place(agent, snapshot),
                        status_text: self
                            .config
                            .sidebar_layout
                            .agents
                            .shows_status_text(agent.agent.as_deref())
                            .then(|| state_label(agent, status_text(agent.agent_status))),
                        lines,
                    }),
                    &row_cx,
                )
                .selected(selected && agent.focused)
                .row()
                .when(gap > 0., |row| row.mt(px(gap)))
                .id(SharedString::from(format!("agent-{endpoint_id}-{id}")))
                .when(multi, |row| {
                    row.debug_selector(|| format!("agent-{endpoint_id}-{id}"))
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.navigate_endpoint(&navigate_endpoint, NavigationTarget::Pane(&id), cx);
                    window.focus(&this.focus, cx);
                })),
            );
        }
        (list, count, focused)
    }
}
