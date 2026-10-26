use super::{Error, LocalDaemon};
use crate::tmux_handoff::ServerScope;
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerRegistration {
    Online { label: String, scope: ServerScope },
    Offline { label: String, server_id: String },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    version: u8,
    servers: Vec<Registration>,
}
#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "lowercase", deny_unknown_fields)]
enum Registration {
    Online {
        #[serde(rename = "serverId")]
        server_id: String,
        label: String,
        generation: String,
    },
    Offline {
        #[serde(rename = "serverId")]
        server_id: String,
        label: String,
        generation: (),
    },
}
impl LocalDaemon {
    /// Fetch server generations only after private-record identity verification.
    pub fn list_servers(&self) -> Result<Vec<ServerRegistration>, Error> {
        parse(&self.get_resource("api/v1/tmux-servers")?)
    }
}
pub(super) fn parse(bytes: &[u8]) -> Result<Vec<ServerRegistration>, Error> {
    let resource: Resource = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if resource.version != 1 || resource.servers.len() > 4096 {
        return Err(Error::ResourceFormat);
    }
    let mut seen = HashSet::new();
    resource
        .servers
        .into_iter()
        .map(|entry| {
            let (server_id, label, generation) = match entry {
                Registration::Online {
                    server_id,
                    label,
                    generation,
                } => (server_id, label, Some(generation)),
                Registration::Offline {
                    server_id,
                    label,
                    generation: (),
                } => (server_id, label, None),
            };
            let Some(suffix) = server_id.strip_prefix("tmux-server.") else {
                return Err(Error::ResourceFormat);
            };
            if suffix.len() != 32
                || !suffix
                    .bytes()
                    .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
                || !seen.insert(server_id.clone())
            {
                return Err(Error::ResourceFormat);
            }
            let label = label.trim().to_owned();
            if label.is_empty()
                || label.encode_utf16().count() > 160
                || label.chars().any(|v| v < ' ' || v == '\u{7f}')
            {
                return Err(Error::ResourceFormat);
            }
            if let Some(generation) = generation {
                if generation.len() != 36 || uuid::Uuid::parse_str(&generation).is_err() {
                    return Err(Error::ResourceFormat);
                }
                Ok(ServerRegistration::Online {
                    label,
                    scope: ServerScope {
                        server_id,
                        generation,
                    },
                })
            } else {
                Ok(ServerRegistration::Offline { label, server_id })
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "servers_tests.rs"]
mod tests;
