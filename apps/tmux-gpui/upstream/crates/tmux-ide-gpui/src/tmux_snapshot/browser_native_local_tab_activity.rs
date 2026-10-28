//! At most eight tabs retain at most 64 exact agent identities each. Display
//! updates never rotate navigation capabilities or create observation workers.
use crate::tmux_snapshot::session_tabs::Activity;
use herdr_client::tmux_daemon::{
    AgentActivity, ObservedAgent, ObservedNativePane, ObservedPaneEndpoint,
};
type Identity = (
    String,
    Option<String>,
    Option<ObservedNativePane>,
    Option<ObservedPaneEndpoint>,
);
#[derive(Default)]
pub(super) struct Badge {
    pub(super) unread: bool,
    pub(super) activity: Option<Activity>,
    previous: Vec<(Identity, AgentActivity)>,
    last_epoch: Option<uuid::Uuid>,
}
impl Badge {
    pub(super) fn unavailable(&mut self) {
        self.last_epoch = None;
        self.previous.clear();
        self.activity = None;
    }
    pub(super) fn observe_once(
        &mut self,
        epoch: uuid::Uuid,
        agents: &[ObservedAgent],
        active: bool,
    ) {
        if self.last_epoch == Some(epoch) {
            if active {
                self.unread = false;
            }
            return;
        }
        self.observe(agents, active);
        self.last_epoch = Some(epoch);
    }
    fn observe(&mut self, agents: &[ObservedAgent], active: bool) {
        if agents.len() > 64
            || agents.iter().any(|a| {
                a.pane_id.is_none()
                    || (a.native_identity.is_none() && a.interaction_endpoint.is_none())
            })
        {
            self.unavailable();
            return;
        }
        let next: Vec<_> = agents
            .iter()
            .map(|a| {
                (
                    (
                        a.id.clone(),
                        a.pane_id.clone(),
                        a.native_identity.clone(),
                        a.interaction_endpoint.clone(),
                    ),
                    a.activity.clone(),
                )
            })
            .collect();
        if !active
            && next.iter().any(|(identity, status)| {
                *status == AgentActivity::Complete
                    && self
                        .previous
                        .iter()
                        .any(|(old, prior)| old == identity && *prior == AgentActivity::Running)
            })
        {
            self.unread = true;
        }
        if active {
            self.unread = false;
        }
        self.previous = next;
        self.activity = Some(
            if agents.iter().any(|a| a.activity == AgentActivity::Failed) {
                Activity::Failed
            } else if agents
                .iter()
                .any(|a| a.attention || a.activity == AgentActivity::Waiting)
            {
                Activity::Waiting
            } else if agents.iter().any(|a| a.activity == AgentActivity::Running) {
                Activity::Running
            } else {
                Activity::Idle
            },
        );
    }
}
#[cfg(test)]
#[path = "browser_native_local_tab_activity_tests.rs"]
mod tests;
