//! Private broker-to-native capability; no reusable owner credential crosses this boundary.
use crate::tmux_stream::{ConnectOptions, IssuedDescriptor};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handoff {
    /// Minted only by verified local capability negotiation; never pipe JSON.
    #[serde(skip)]
    pub native_surfaces: bool,
    /// In-memory native SSH provenance; never accepted from broker JSON.
    #[serde(skip)]
    pub remote_peer: Option<crate::tmux_ssh::PeerIdentity>,
    pub descriptor: IssuedDescriptor,
    pub origin: String,
    pub host_client_id: String,
    pub workspace_name: String,
    pub selected_pane: String,
    #[serde(default)]
    pub catalog_only: bool,
    /// The trusted broker offered graphics (101–104 plus 107 or local 108).
    /// This is not daemon confirmation; each graphics state confirms its accepted features.
    #[serde(default)]
    pub graphics: bool,
    /// The broker offered binary cells; delivery-ready still confirms the encoding.
    #[serde(default)]
    pub binary_cells: bool,
    #[serde(default)]
    pub alternate_screen_projection: bool,
    #[serde(default, deserialize_with = "optional_local_images")]
    pub local_images: Option<crate::tmux_graphics::LocalImages>,
    /// Public owner scope for history response fencing; never an owner credential.
    #[serde(default, deserialize_with = "optional_server_scope")]
    pub server_scope: Option<ServerScope>,
    /// The local daemon's product version, for compatibility notices only; never broker JSON.
    #[serde(skip)]
    pub daemon_version: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerScope {
    pub server_id: String,
    pub generation: String,
}
fn optional_local_images<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<crate::tmux_graphics::LocalImages>, D::Error> {
    crate::tmux_graphics::LocalImages::deserialize(deserializer).map(Some)
}
fn optional_server_scope<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ServerScope>, D::Error> {
    ServerScope::deserialize(deserializer).map(Some)
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("native handoff exceeds its bound")]
    Bounds,
    #[error("invalid native handoff")]
    Json(#[source] serde_json::Error),
    #[error("native handoff selection is outside the capability")]
    Selection,
    #[error("invalid native handoff envelope")]
    Envelope,
    #[error("native handoff server scope mismatch")]
    Scope,
}
impl Handoff {
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > 16384 {
            return Err(Error::Bounds);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(Error::Json)?;
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> Result<(), Error> {
        let value = self;
        if (value.catalog_only
            && value.descriptor.effective_viewer_mode != crate::tmux_stream::ViewerMode::ReadOnly)
            || value.workspace_name.is_empty()
            || value.workspace_name.len() > 512
            || !value.descriptor.panes.contains(&value.selected_pane)
        {
            return Err(Error::Selection);
        }
        if value
            .local_images
            .as_ref()
            .is_some_and(|root| !value.graphics || !root.validate())
        {
            return Err(Error::Scope);
        }
        if let Some(scope) = &value.server_scope
            && (scope.server_id.len() != 44
                || !scope.server_id.starts_with("tmux-server.")
                || !scope.server_id[12..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || scope.generation.len() != 36
                || uuid::Uuid::parse_str(&scope.generation).is_err()
                || scope.generation != value.descriptor.daemon_instance_id)
        {
            return Err(Error::Scope);
        }
        Ok(())
    }
    pub fn into_connection(self) -> (ConnectOptions, String, String) {
        (
            ConnectOptions {
                remote_peer: self.remote_peer,
                descriptor: self.descriptor,
                origin: self.origin,
                host_client_id: self.host_client_id,
            },
            self.workspace_name,
            self.selected_pane,
        )
    }
}

/// Ordered pipe messages. These carry one-use secrets and deliberately do not implement Debug.
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Event {
    #[serde(rename = "native-terminal-open", rename_all = "camelCase")]
    Open {
        version: u8,
        id: String,
        request: u64,
        live_session_id: String,
        capability: Box<Handoff>,
    },
    #[serde(rename = "native-terminal-close")]
    Close {
        version: u8,
        id: String,
        request: u64,
    },
}
impl Event {
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > 20 * 1024 {
            return Err(Error::Bounds);
        }
        let event: Self = serde_json::from_slice(bytes).map_err(Error::Json)?;
        let (version, id, request) = match &event {
            Self::Open {
                version,
                id,
                request,
                live_session_id,
                capability,
            } => {
                capability.validate()?;
                if live_session_id.is_empty() || live_session_id.len() > 512 {
                    return Err(Error::Envelope);
                }
                (*version, id, *request)
            }
            Self::Close {
                version,
                id,
                request,
            } => (*version, id, *request),
        };
        if version != 1 || uuid::Uuid::parse_str(id).is_err() || request > 9_007_199_254_740_991 {
            return Err(Error::Envelope);
        }
        Ok(event)
    }
}

#[cfg(test)]
#[path = "tmux_handoff_tests.rs"]
mod tests;
