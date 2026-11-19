use super::{Error, ServerClient};
use crate::tmux_handoff::ServerScope;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Opened {
    version: u8,
    server: ServerScope,
    workspace_name: String,
    live_session_id: String,
}
impl ServerClient {
    /// Admit an observed session to the terminal runtime. Sends once; callers
    /// must re-observe the catalog after a failed or retired request.
    ///
    /// One request (attach-rtt). The daemon fences it on the generation in
    /// the path and matches the live id against tmux itself, and the answer
    /// names the scope and live id, which `parse` checks. Only a refusal reads
    /// the catalog, to tell a session that is gone from any other failure.
    pub fn open_session(&self, live_session_id: &str) -> Result<String, Error> {
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/sessions/{live_session_id}/open",
            scope.server_id, scope.generation
        );
        self.assert_current()?;
        let result = self.daemon.post_resource(&path, b"{}");
        self.assert_current()?;
        let bytes = result.map_err(|error| self.refused(error, live_session_id, None))?;
        let workspace = parse(&bytes, scope, live_session_id)?;
        self.assert_current()?;
        Ok(workspace)
    }
    /// A request the daemon refused: `ServerChanged` when the generation is
    /// stale (409) or one catalog read no longer lists the session (with its
    /// workspace alias, when given), else the refusal itself. A transport
    /// failure is returned unchanged, with no further request.
    pub(super) fn refused(
        &self,
        error: Error,
        live_session_id: &str,
        workspace: Option<&str>,
    ) -> Error {
        match error {
            Error::RequestStatus(409) => Error::ServerChanged,
            Error::RequestStatus(_) => match self.sessions() {
                Ok(sessions)
                    if !sessions.iter().any(|s| {
                        s.live_session_id == live_session_id
                            && workspace.is_none_or(|w| s.workspace_name.as_deref() == Some(w))
                    }) =>
                {
                    Error::ServerChanged
                }
                Err(Error::Retired) => Error::Retired,
                _ => error,
            },
            other => other,
        }
    }
}
fn parse(bytes: &[u8], scope: &ServerScope, live_session_id: &str) -> Result<String, Error> {
    let opened: Opened = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if opened.version != 1 || !crate::tmux_stream::valid_identity(&opened.workspace_name) {
        return Err(Error::ResourceFormat);
    }
    if &opened.server != scope || opened.live_session_id != live_session_id {
        return Err(Error::ServerChanged);
    }
    Ok(opened.workspace_name)
}
#[cfg(test)]
#[path = "open_session_tests.rs"]
mod tests;
