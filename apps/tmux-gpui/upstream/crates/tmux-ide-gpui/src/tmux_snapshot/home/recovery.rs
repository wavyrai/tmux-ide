//! Explicit metadata observation recovery; never session/terminal navigation.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Capability {
    pub revision: u64,
    pub can_retry: bool,
    pub can_load_more: bool,
}
#[derive(Clone, Copy, Serialize)]
pub(in crate::tmux_snapshot) enum Action {
    #[serde(rename = "retry")]
    Retry,
    #[serde(rename = "load-more")]
    LoadMore,
}
impl SnapshotView {
    fn recovery_available(&self, request: u64, revision: u64, action: Action) -> bool {
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
                .is_some_and(|c| c.recovery_queued != Some((request, revision)))
            && self
                .browser_state
                .home_agents
                .as_ref()
                .is_some_and(|r| r.revision == revision)
            && self
                .browser_state
                .home_agent_recovery
                .as_ref()
                .is_some_and(|c| {
                    c.revision == revision
                        && match action {
                            Action::Retry => c.can_retry,
                            Action::LoadMore => c.can_load_more,
                        }
                })
    }
    pub(in crate::tmux_snapshot) fn recover_home_agents(
        &mut self,
        request: u64,
        revision: u64,
        action: Action,
        cx: &mut Context<Self>,
    ) {
        if !self.recovery_available(request, revision, action) {
            return;
        }
        let queued = self.browser_commands.as_ref().is_some_and(|sender| {
            sender
                .try_send(browser::Command::HomeAgentRecovery {
                    request,
                    roster_revision: revision,
                    action,
                })
                .is_ok()
        });
        if let Some(controls) = &mut self.home_filter {
            controls.recovery_error = !queued;
            if queued {
                controls.recovery_queued = Some((request, revision));
            }
        }
        cx.notify();
    }
    pub(super) fn home_recovery_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut row = div().flex().flex_wrap().gap_2().min_w_0();
        if let Some(capability) = &self.browser_state.home_agent_recovery {
            let request = self.browser_request;
            let revision = capability.revision;
            for (action, id, label) in [
                (Action::Retry, "home-agents-retry", "Retry observations"),
                (
                    Action::LoadMore,
                    "home-agents-load-more",
                    "Load more sessions",
                ),
            ] {
                if self.recovery_available(request, revision, action) {
                    row = row.child(
                        super::super::controls::button(
                            id,
                            Some(label),
                            label,
                            super::super::controls::Icon::Refresh,
                            &self.theme(),
                        )
                        .on_click(cx.listener(move |view, _, _, cx| {
                            cx.stop_propagation();
                            view.recover_home_agents(request, revision, action, cx);
                        })),
                    );
                }
            }
        }
        if self.home_filter.as_ref().is_some_and(|c| c.recovery_error) {
            row = row.child(
                div()
                    .text_sm()
                    .child("Observation request not queued — try again"),
            );
        }
        row.into_any_element()
    }
}
