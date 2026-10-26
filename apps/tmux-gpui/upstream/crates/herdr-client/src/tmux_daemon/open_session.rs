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
    pub fn open_session(&self, live_session_id: &str) -> Result<String, Error> {
        if !self
            .sessions()?
            .iter()
            .any(|s| s.live_session_id == live_session_id)
        {
            return Err(Error::ServerChanged);
        }
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/sessions/{live_session_id}/open",
            scope.server_id, scope.generation
        );
        self.assert_current()?;
        let result = self.daemon.post_resource(&path, b"{}");
        self.assert_current()?;
        let workspace = parse(&result?, scope, live_session_id)?;
        if !self.sessions()?.iter().any(|s| {
            s.live_session_id == live_session_id && s.workspace_name.as_ref() == Some(&workspace)
        }) {
            return Err(Error::ServerChanged);
        }
        self.assert_current()?;
        Ok(workspace)
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
