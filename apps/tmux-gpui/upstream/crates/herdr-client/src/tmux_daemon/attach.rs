//! attach-rtt: open a session, read its inventory and issue its stream in one
//! request, on a daemon that knows it (`capability::attaches`). Any other
//! daemon gets the open and the inventory read, and the stream is issued
//! afterwards as before.
use super::{
    Error, ServerClient, TerminalSelection, WorkspaceInventory,
    capability::{attaches, issue_body, issue_headers},
};
use crate::{tmux_handoff::Handoff, tmux_stream::ViewerMode};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

/// A stream the daemon issued with the open, for the window and panes it
/// chose. The app uses it only when its own rule chooses the same.
pub struct PreparedStream {
    pub window: Option<String>,
    pub panes: Vec<String>,
    pub selected: String,
    pub handoff: Handoff,
}
pub struct Attached {
    pub workspace_name: String,
    pub inventory: WorkspaceInventory,
    pub stream: Option<Box<PreparedStream>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Answer {
    version: u8,
    server: crate::tmux_handoff::ServerScope,
    workspace_name: String,
    live_session_id: String,
    inventory: Value,
    selection: Option<Selection>,
    issue: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    semantic_window_id: Option<String>,
    panes: Vec<String>,
    selected_pane: String,
}

impl ServerClient {
    /// Whether this daemon answers the one-request attach.
    pub fn attaches(&self) -> bool {
        attaches(self.product_version().as_deref())
    }
    /// Open `live_session_id` for a stream: one request on a daemon that
    /// attaches, else the open and the inventory read. Over SSH the stream's
    /// socket is dialed and proven meanwhile. `max_panes` and `preferred` are
    /// the app's window rule's inputs; the daemon applies the same rule.
    pub fn attach_session(
        &self,
        live_session_id: &str,
        preferred: Option<&str>,
        max_panes: usize,
    ) -> Result<Attached, Error> {
        self.assert_current()?;
        self.prepare_stream();
        if !self.attaches() {
            let workspace_name = self.open_session(live_session_id)?;
            let inventory = self.workspace_inventory(live_session_id, &workspace_name)?;
            return Ok(Attached {
                workspace_name,
                inventory,
                stream: None,
            });
        }
        let prelude = self.issue_prelude(true, true)?;
        let request_id = Uuid::new_v4().to_string();
        let host_client_id = format!("gpui:{}", Uuid::new_v4());
        let scope = self.scope().clone();
        // The issue body without what only the daemon knows here.
        let unchosen = TerminalSelection {
            workspace_name: String::new(),
            live_session_id: live_session_id.into(),
            selected_pane: String::new(),
            visible_panes: Vec::new(),
            mode: ViewerMode::Interactive,
            window: None,
        };
        let mut issue: Value = serde_json::from_str(&issue_body(
            &request_id,
            &scope.generation,
            &unchosen,
            &prelude.versions,
            prelude.daemon_version.as_deref(),
        )?)
        .map_err(|_| Error::ResourceFormat)?;
        if let Some(stream) = issue["stream"].as_object_mut() {
            stream.remove("workspaceName");
            stream.remove("panes");
        }
        let body = serde_json::json!({
            "version": 1,
            "preferredPane": preferred,
            "maxPanes": max_panes,
            "issue": issue,
        });
        let path = format!(
            "api/v1/tmux-servers/{}/{}/sessions/{live_session_id}/attach",
            scope.server_id, scope.generation
        );
        self.assert_current()?;
        let result = self.daemon.post_resource_with_headers(
            &path,
            body.to_string().as_bytes(),
            &issue_headers(&request_id, &scope.generation, &host_client_id),
        );
        self.assert_current()?;
        let bytes = result.map_err(|error| self.refused(error, live_session_id, None))?;
        let answer: Answer = serde_json::from_slice(&bytes).map_err(|_| Error::ResourceFormat)?;
        if answer.version != 1 || !crate::tmux_stream::valid_identity(&answer.workspace_name) {
            return Err(Error::ResourceFormat);
        }
        if answer.server != scope || answer.live_session_id != live_session_id {
            return Err(Error::ServerChanged);
        }
        let envelope =
            serde_json::json!({"version": 2, "server": scope, "resource": answer.inventory});
        let inventory = super::inventory::parse(
            &serde_json::to_vec(&envelope).map_err(|_| Error::ResourceFormat)?,
            &scope,
            &answer.workspace_name,
        )?;
        let stream = match (answer.selection, answer.issue) {
            (Some(selection), Some(issue)) => {
                let chosen = TerminalSelection {
                    workspace_name: answer.workspace_name.clone(),
                    live_session_id: live_session_id.into(),
                    selected_pane: selection.selected_pane,
                    visible_panes: selection.panes,
                    mode: ViewerMode::Interactive,
                    window: selection.semantic_window_id,
                };
                chosen.validate()?;
                let issued = serde_json::to_vec(&issue).map_err(|_| Error::ResourceFormat)?;
                match self.issue_finish(prelude, &chosen, &request_id, host_client_id, &issued) {
                    Ok(handoff) => Some(Box::new(PreparedStream {
                        window: chosen.window,
                        panes: chosen.visible_panes,
                        selected: chosen.selected_pane,
                        handoff,
                    })),
                    // A refusal is the issue stage's to report, as before.
                    Err(Error::StreamRefused { .. }) => None,
                    Err(error) => return Err(error),
                }
            }
            (None, None) => None,
            _ => return Err(Error::ResourceFormat),
        };
        self.assert_current()?;
        Ok(Attached {
            workspace_name: answer.workspace_name,
            inventory,
            stream,
        })
    }
}
