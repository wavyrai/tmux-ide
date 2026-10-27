//! The bridge filters before its row cap; native search/activity remain local.
use super::*;
use serde::Deserialize;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Capability {
    pub revision: u64,
    pub machine_id: Option<String>,
}
impl SnapshotView {
    fn machine_filter_ready(&self, request: u64, revision: u64) -> bool {
        self.browser_request == request
            && self.browser_state.request == request
            && self.browser_state.surface == browser::Surface::Home
            && self.browser_state.fleet.is_some()
            && self.browser_commands.is_some()
            && self.presence.ready()
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
            && self
                .home_filter
                .as_ref()
                .is_some_and(|c| c.machine_queued != Some((request, revision)))
            && self
                .browser_state
                .home_agents
                .as_ref()
                .is_some_and(|r| r.revision == revision)
            && self
                .browser_state
                .home_agent_filter
                .as_ref()
                .is_some_and(|c| c.revision == revision)
    }
    pub(in crate::tmux_snapshot) fn cycle_home_machine(
        &mut self,
        request: u64,
        revision: u64,
        cx: &mut Context<Self>,
    ) {
        if !self.machine_filter_ready(request, revision) {
            return;
        }
        let Some(fleet) = &self.browser_state.fleet else {
            return;
        };
        let Some(capability) = &self.browser_state.home_agent_filter else {
            return;
        };
        let next = match &capability.machine_id {
            None => fleet.groups.first().map(|g| g.id.clone()),
            Some(id) => {
                let Some(index) = fleet.groups.iter().position(|g| &g.id == id) else {
                    return;
                };
                fleet.groups.get(index + 1).map(|g| g.id.clone())
            }
        };
        let queued = self.browser_commands.as_ref().is_some_and(|sender| {
            sender
                .try_send(browser::Command::HomeAgentFilter {
                    request,
                    roster_revision: revision,
                    machine_id: next,
                })
                .is_ok()
        });
        if let Some(c) = &mut self.home_filter {
            c.machine_error = !queued;
            if queued {
                c.machine_queued = Some((request, revision));
            }
        }
        cx.notify();
    }
    pub(super) fn home_machine_control(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(capability) = &self.browser_state.home_agent_filter else {
            return div().into_any_element();
        };
        let theme = self.theme();
        let label = capability
            .machine_id
            .as_ref()
            .and_then(|id| {
                self.browser_state
                    .fleet
                    .as_ref()?
                    .groups
                    .iter()
                    .find(|g| &g.id == id)
            })
            .map_or("All machines", |g| g.label.as_str());
        let request = self.browser_request;
        let revision = capability.revision;
        let enabled = self.machine_filter_ready(request, revision);
        let mut button = super::super::controls::button(
            "home-machine-filter",
            None,
            "Cycle machine filter (f)",
            super::super::controls::Icon::Sessions,
            &theme,
        )
        .w_auto()
        .max_w(px(240.))
        .px_3()
        .child(div().min_w_0().truncate().child(format!("{label} · f")));
        if enabled {
            button = button.on_click(cx.listener(move |view, _, _, cx| {
                cx.stop_propagation();
                view.cycle_home_machine(request, revision, cx);
            }));
        } else {
            button = button.text_color(rgb(theme.muted));
        }
        let mut body = div().flex().flex_col().child(button);
        if self.home_filter.as_ref().is_some_and(|c| c.machine_error) {
            body = body.child(
                div()
                    .text_sm()
                    .child("Machine filter not queued — try again"),
            );
        }
        body.into_any_element()
    }
}
