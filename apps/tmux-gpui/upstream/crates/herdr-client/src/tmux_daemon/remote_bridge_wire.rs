//! Bridge protocol v1 as the app reads it. The daemon only reports; no frame
//! asks the app for anything, and nothing here touches the pasteboard.
use serde::Deserialize;

pub(super) const CAPABILITY_PATH: &str = "api/v2/capabilities?remoteBridge=1";
pub(super) const PATH: &str = "/api/v2/bridge";
pub(super) const SUBPROTOCOL: &str = "tmux-ide-bridge-v1";
pub(super) const VERSION: u64 = 1;
pub(super) const CLIPBOARD_WRITE: &str = "clipboard-write";
pub(super) const HELLO: &str = r#"{"type":"hello","version":1}"#;
/// The daemon caps a copy at 1 MiB of UTF-8.
pub const MAX_TEXT_BYTES: usize = 1 << 20;
/// A 1 MiB copy of control characters escapes to about 6 MiB of JSON.
pub(super) const MAX_MESSAGE_BYTES: usize = 8 << 20;
const MAX_ID_BYTES: usize = 256;

/// A copy a program in a pane made, or one the daemon refused to forward.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BridgeEvent {
    Clipboard {
        session: String,
        pane_id: String,
        incarnation: String,
        text: String,
    },
    TooLarge {
        session: String,
        pane_id: String,
        incarnation: String,
        bytes: u64,
    },
}

impl BridgeEvent {
    pub fn pane_id(&self) -> &str {
        match self {
            Self::Clipboard { pane_id, .. } | Self::TooLarge { pane_id, .. } => pane_id,
        }
    }
}

/// True when the capabilities answer offers bridge v1 with remote copy. An
/// older daemon has no `remoteBridge` field: no bridge, as before.
pub(super) fn offers_clipboard(bytes: &[u8]) -> bool {
    #[derive(Deserialize)]
    struct Response {
        status: String,
        capabilities: Capabilities,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Capabilities {
        #[serde(default)]
        remote_bridge: Option<Offer>,
    }
    #[derive(Deserialize)]
    struct Offer {
        version: u64,
        path: String,
        features: Vec<String>,
    }
    serde_json::from_slice::<Response>(bytes).is_ok_and(|response| {
        response.status == "ok"
            && response.capabilities.remote_bridge.is_some_and(|offer| {
                offer.version == VERSION
                    && offer.path == PATH
                    && offer.features.iter().any(|f| f == CLIPBOARD_WRITE)
            })
    })
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Frame {
    #[serde(rename = "ready")]
    Ready(Ready),
    #[serde(rename = "clipboard.write")]
    Write(Write),
    #[serde(rename = "clipboard.refused")]
    Refused(Refused),
    /// A later daemon's report this app does not know: ignored.
    #[serde(other)]
    Unknown,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    version: u64,
    features: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Write {
    session: String,
    pane_id: String,
    incarnation: String,
    bytes: u64,
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Refused {
    session: String,
    pane_id: String,
    incarnation: String,
    bytes: u64,
    reason: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Received {
    Ready,
    Event(BridgeEvent),
    /// Unknown or unusable: nothing to do.
    Ignored,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum WireError {
    #[error("bridge frame is not valid JSON of a known shape")]
    Malformed,
    #[error("bridge ready frame names another version or lacks remote copy")]
    Version,
}

fn ids_ok(session: &str, pane_id: &str, incarnation: &str) -> bool {
    !pane_id.is_empty()
        && pane_id.len() <= MAX_ID_BYTES
        && session.len() <= MAX_ID_BYTES * 4
        && incarnation.len() <= MAX_ID_BYTES
}

/// Reads one text frame.
pub(super) fn receive(text: &str) -> Result<Received, WireError> {
    let frame: Frame = serde_json::from_str(text).map_err(|_| WireError::Malformed)?;
    Ok(match frame {
        Frame::Ready(ready) => {
            if ready.version != VERSION || !ready.features.iter().any(|f| f == CLIPBOARD_WRITE) {
                return Err(WireError::Version);
            }
            Received::Ready
        }
        Frame::Write(write) => {
            let usable = ids_ok(&write.session, &write.pane_id, &write.incarnation)
                && !write.text.is_empty()
                && write.text.len() <= MAX_TEXT_BYTES
                && write.bytes == write.text.len() as u64
                && !write.text.contains('\0');
            if !usable {
                return Ok(Received::Ignored);
            }
            Received::Event(BridgeEvent::Clipboard {
                session: write.session,
                pane_id: write.pane_id,
                incarnation: write.incarnation,
                text: write.text,
            })
        }
        Frame::Refused(refused) => {
            if refused.reason != "too-large"
                || !ids_ok(&refused.session, &refused.pane_id, &refused.incarnation)
            {
                return Ok(Received::Ignored);
            }
            Received::Event(BridgeEvent::TooLarge {
                session: refused.session,
                pane_id: refused.pane_id,
                incarnation: refused.incarnation,
                bytes: refused.bytes,
            })
        }
        Frame::Unknown => Received::Ignored,
    })
}

#[cfg(test)]
#[path = "remote_bridge_wire_tests.rs"]
mod tests;
