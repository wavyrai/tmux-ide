//! Read-only agent observations. These identities are observations, never leases.
use super::{Error, ServerClient};
use crate::tmux_handoff::ServerScope;
use serde::Deserialize;
#[path = "agent_observation_wire.rs"]
mod wire;
pub use wire::{
    AgentActivity, ObservedHarness, ObservedNativePane, ObservedPaneEndpoint, ObservedTeam,
    TeamSource as ObservedTeamSource,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentObservation {
    pub scope: ServerScope,
    pub live_session_id: String,
    pub workspace_name: String,
    pub project_name: String,
    pub agents: Vec<ObservedAgent>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedAgent {
    pub id: String,
    pub name: String,
    pub harness: ObservedHarness,
    pub activity: AgentActivity,
    pub attention: bool,
    pub pane_id: Option<String>,
    pub window_id: Option<String>,
    pub native_identity: Option<ObservedNativePane>,
    pub interaction_endpoint: Option<ObservedPaneEndpoint>,
    pub team: Option<ObservedTeam>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct AgentSelection {
    pub catalog_identity: super::CatalogIdentity,
    pub live_session_id: String,
    pub workspace_name: String,
    pub agent: ObservedAgent,
}
pub struct OpenedAgent {
    pub workspace_name: String,
    pub panes: Vec<String>,
    pub selected: String,
}
impl ServerClient {
    pub fn open_observed_agent(&self, selection: &AgentSelection) -> Result<OpenedAgent, Error> {
        if self.daemon.catalog_identity() != selection.catalog_identity {
            return Err(Error::IdentityChanged);
        }
        let expected = &selection.agent;
        let Some(pane) = expected.pane_id.as_ref().filter(|_| {
            expected.native_identity.is_some() || expected.interaction_endpoint.is_some()
        }) else {
            return Err(Error::ActionInput);
        };
        let verify = || -> Result<(), Error> {
            let observation =
                self.observe_agents(&selection.live_session_id, &selection.workspace_name)?;
            if !observation
                .agents
                .iter()
                .any(|current| same_agent_target(expected, current))
            {
                return Err(Error::ServerChanged);
            }
            Ok(())
        };
        verify()?;
        let workspace = self.open_session(&selection.live_session_id)?;
        if workspace != selection.workspace_name {
            return Err(Error::ServerChanged);
        }
        verify()?;
        let panes = self.workspace_panes(&selection.live_session_id, &workspace)?;
        if !panes.contains(pane) {
            return Err(Error::ServerChanged);
        }
        Ok(OpenedAgent {
            workspace_name: workspace,
            panes,
            selected: pane.clone(),
        })
    }
}
fn same_agent_target(expected: &ObservedAgent, current: &ObservedAgent) -> bool {
    expected.id == current.id
        && expected.pane_id.is_some()
        && expected.pane_id == current.pane_id
        && (expected.native_identity.is_some() || expected.interaction_endpoint.is_some())
        && expected.native_identity == current.native_identity
        && expected.interaction_endpoint == current.interaction_endpoint
}
pub(super) fn valid_target(live: &str, workspace: &str) -> bool {
    wire::live_id(live) && wire::workspace(workspace)
}
impl ServerClient {
    /// Observe an already registered live session; never open/adopt a session or
    /// acquire an interactive stream. Cancellation and generation checks apply to
    /// each read, including the session observations on either side of the shell.
    pub fn observe_agents(&self, live: &str, workspace: &str) -> Result<AgentObservation, Error> {
        if !valid_target(live, workspace) {
            return Err(Error::ActionInput);
        }
        let matches = |sessions: &[super::Session]| {
            sessions.iter().any(|s| {
                s.live_session_id == live && s.workspace_name.as_deref() == Some(workspace)
            })
        };
        if !matches(&self.sessions()?) {
            return Err(Error::ServerChanged);
        }
        let encoded: String = url::form_urlencoded::byte_serialize(workspace.as_bytes()).collect();
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/application-shell/{encoded}?liveSessionId={live}",
            scope.server_id, scope.generation
        );
        let bytes = self.daemon.get_resource(&path)?;
        self.assert_current()?;
        let result = parse(&bytes, scope, live, workspace)?;
        if !matches(&self.sessions()?) {
            return Err(Error::ServerChanged);
        }
        self.assert_current()?;
        Ok(result)
    }
}
fn parse(
    bytes: &[u8],
    scope: &ServerScope,
    live: &str,
    workspace: &str,
) -> Result<AgentObservation, Error> {
    if bytes.len() > 1024 * 1024 {
        return Err(Error::ResourceFormat);
    }
    let envelope: wire::Envelope =
        serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if envelope.version != 1 {
        return Err(Error::ResourceFormat);
    }
    if &envelope.server != scope {
        return Err(Error::ServerChanged);
    }
    let resource = envelope.resource;
    resource.validate(scope, workspace)?;
    let agents = resource.workspace.sidebar.agents.into_iter().map(|agent| {
        let pane = agent.pane_id.as_ref().and_then(|id| resource.terminal_inventory.resources.iter()
            .find(|r| &r.id == id && matches!(&r.attachability,wire::Attachability::Available {semantic_pane_id} if semantic_pane_id==id)));
        ObservedAgent {
            id:agent.id, name:agent.name, harness:agent.harness, activity:agent.activity,
            attention:agent.attention, pane_id:agent.pane_id.clone(), team:agent.team,
            window_id:pane.and_then(|r|r.window_resource_id.clone()),
            native_identity:pane.and_then(|r|r.native_identity.clone()),
            interaction_endpoint:pane.and_then(|r|r.interaction_endpoint.clone()),
        }
    }).collect();
    Ok(AgentObservation {
        scope: scope.clone(),
        live_session_id: live.into(),
        workspace_name: workspace.into(),
        project_name: resource.project.name,
        agents,
    })
}
#[cfg(test)]
#[path = "agent_observation_tests.rs"]
mod tests;
