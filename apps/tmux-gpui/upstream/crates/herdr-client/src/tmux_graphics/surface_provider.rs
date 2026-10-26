//! Typed control messages for the authenticated native producer connection.
//! Parsing does not prove locality: the producer must authenticate the daemon and
//! complete the receiver's kernel challenge before transferring any storage.
use super::surface_control::MAX_CONTROL_BYTES;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PATH: &str = "/v1/terminal/native-surface-provider";
pub const PROTOCOL: &str = "tmux-ide-native-surface-provider-v1";
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid native provider control message")]
    Json(#[source] serde_json::Error),
    #[error("native provider control exceeds its bounds")]
    Bounds,
    #[error("native provider control generation mismatch")]
    Generation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receiver {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    pub generation: Uuid,
    pub connection_nonce: Uuid,
    pub challenge: Uuid,
    pub pid: u32,
    pub slot: u8,
    pub audit_token: [u32; 8],
}
impl Receiver {
    fn valid(&self) -> bool {
        self.kind == "terminal-surface-receiver"
            && self.version == 1
            && !self.generation.is_nil()
            && !self.connection_nonce.is_nil()
            && !self.challenge.is_nil()
            && self.pid > 0
            && self.pid <= i32::MAX as u32
            && self.slot < 32
            && self.audit_token != [0; 8]
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Event {
    KittyDemand {
        panes: Vec<String>,
        required: Vec<String>,
    },
    Registered {
        version: u8,
        generation: Uuid,
    },
    Start {
        connection: Uuid,
        receiver: Receiver,
        panes: Vec<String>,
    },
    Offered {
        connection: Uuid,
        sequence: u64,
        accepted: bool,
    },
    Retired {
        connection: Uuid,
        sequence: u64,
    },
    Fallback {
        connection: Uuid,
    },
    Close {
        connection: Uuid,
    },
}
impl Event {
    pub fn parse(bytes: &[u8], expected_generation: Uuid) -> Result<Self, Error> {
        if bytes.len() > MAX_CONTROL_BYTES || expected_generation.is_nil() {
            return Err(Error::Bounds);
        }
        let event: Self = serde_json::from_slice(bytes).map_err(Error::Json)?;
        let connection = match &event {
            Self::KittyDemand { panes, required } => {
                validate_panes(panes)?;
                if required.len() > panes.len()
                    || required
                        .iter()
                        .enumerate()
                        .any(|(i, pane)| !panes.contains(pane) || required[..i].contains(pane))
                {
                    return Err(Error::Bounds);
                }
                None
            }
            Self::Registered {
                version,
                generation,
            } => {
                if *version != 1 {
                    return Err(Error::Bounds);
                }
                if *generation != expected_generation {
                    return Err(Error::Generation);
                }
                None
            }
            Self::Start {
                connection,
                receiver,
                panes,
            } => {
                if !receiver.valid()
                    || panes.is_empty()
                    || panes.len() > 24
                    || panes.iter().enumerate().any(|(i, pane)| {
                        !crate::tmux_stream::valid_pane(pane) || panes[..i].contains(pane)
                    })
                {
                    return Err(Error::Bounds);
                }
                if receiver.generation != expected_generation {
                    return Err(Error::Generation);
                }
                Some(connection)
            }
            Self::Offered {
                connection,
                sequence,
                ..
            }
            | Self::Retired {
                connection,
                sequence,
            } => {
                if *sequence == 0 || *sequence > 9_007_199_254_740_991 {
                    return Err(Error::Bounds);
                }
                Some(connection)
            }
            Self::Fallback { connection } | Self::Close { connection } => Some(connection),
        };
        if connection.is_some_and(Uuid::is_nil) {
            return Err(Error::Bounds);
        }
        Ok(event)
    }
}
/// The audit identity is public kernel identity, not the daemon owner credential.
/// Send only on the verified owner-authenticated provider WebSocket.
pub fn register(generation: Uuid, audit_token: [u32; 8]) -> Result<String, Error> {
    if generation.is_nil() || audit_token == [0; 8] {
        return Err(Error::Bounds);
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Registration {
        #[serde(rename = "type")]
        kind: &'static str,
        version: u8,
        generation: Uuid,
        audit_token: [u32; 8],
    }
    serde_json::to_string(&Registration {
        kind: "register",
        version: 1,
        generation,
        audit_token,
    })
    .map_err(Error::Json)
}

fn validate_panes(panes: &[String]) -> Result<(), Error> {
    if panes.is_empty()
        || panes.len() > 32
        || panes
            .iter()
            .enumerate()
            .any(|(i, pane)| !crate::tmux_stream::valid_pane(pane) || panes[..i].contains(pane))
    {
        return Err(Error::Bounds);
    }
    Ok(())
}
pub fn watch_demand(panes: &[String]) -> Result<String, Error> {
    validate_panes(panes)?;
    let encoded = serde_json::to_string(&serde_json::json!({"type":"watch-demand", "panes":panes}))
        .map_err(Error::Json)?;
    if encoded.len() > MAX_CONTROL_BYTES {
        return Err(Error::Bounds);
    }
    Ok(encoded)
}

#[cfg(test)]
#[path = "surface_provider_tests.rs"]
mod tests;
