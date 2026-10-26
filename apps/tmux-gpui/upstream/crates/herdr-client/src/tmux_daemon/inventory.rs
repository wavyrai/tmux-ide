use super::{Error, ServerClient};
use crate::{tmux_handoff::ServerScope, tmux_stream::valid_pane};
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    server: ServerScope,
    resource: Inventory,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inventory {
    workspace_name: String,
    workspace_id: String,
    session_id: String,
    resource_revision: u64,
    semantic_pane_ids: Vec<String>,
}
impl ServerClient {
    /// Creation receipts precede inventory publication. Observe readiness without
    /// ever resending the mutation; cancellation retires the wait as well.
    pub(super) fn await_created_pane(
        &self,
        live: &str,
        workspace: &str,
        pane: &str,
    ) -> Result<(), Error> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            self.assert_current()?;
            if self
                .workspace_panes(live, workspace)?
                .iter()
                .any(|id| id == pane)
            {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(Error::PaneNotReady);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    /// Read topology between two observations of the exact session incarnation.
    pub fn workspace_panes(
        &self,
        live_session_id: &str,
        workspace_name: &str,
    ) -> Result<Vec<String>, Error> {
        let matches = |sessions: &[super::Session]| {
            sessions.iter().any(|s| {
                s.live_session_id == live_session_id
                    && s.workspace_name.as_deref() == Some(workspace_name)
            })
        };
        if !matches(&self.sessions()?) {
            return Err(Error::ServerChanged);
        }
        let workspace: String =
            url::form_urlencoded::byte_serialize(workspace_name.as_bytes()).collect();
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/inventory/{workspace}",
            scope.server_id, scope.generation
        );
        let bytes = self.daemon.get_resource(&path)?;
        self.assert_current()?;
        let panes = parse(&bytes, scope, workspace_name)?;
        if !matches(&self.sessions()?) {
            return Err(Error::ServerChanged);
        }
        self.assert_current()?;
        Ok(panes)
    }
}
fn parse(bytes: &[u8], scope: &ServerScope, workspace: &str) -> Result<Vec<String>, Error> {
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if envelope.version != 1 {
        return Err(Error::ResourceFormat);
    }
    if &envelope.server != scope || envelope.resource.workspace_name.trim() != workspace {
        return Err(Error::ServerChanged);
    }
    let resource = envelope.resource;
    let product = &resource.workspace_id;
    let fleet = resource.session_id.strip_prefix("session.");
    if product.is_empty()
        || product.len() > 128
        || !product.as_bytes()[0].is_ascii_alphanumeric()
        || !product
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        || fleet.is_none_or(|s| {
            !(16..=64).contains(&s.len())
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
        || resource.resource_revision > 9_007_199_254_740_991
        || resource.semantic_pane_ids.len() > 256
        || resource.semantic_pane_ids.iter().any(|p| !valid_pane(p))
        || resource
            .semantic_pane_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return Err(Error::ResourceFormat);
    }
    Ok(resource.semantic_pane_ids)
}
#[cfg(test)]
#[path = "inventory_tests.rs"]
mod tests;
