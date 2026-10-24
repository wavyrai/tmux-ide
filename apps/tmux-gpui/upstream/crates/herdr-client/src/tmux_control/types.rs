use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Authority {
    Input,
    Focus,
    Geometry,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lifetime {
    pub generation: String,
    pub incarnation: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    pub generation: String,
    pub session: String,
    pub client_id: String,
    pub authority: Authority,
    pub token: String,
    pub revision: u64,
}
impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease")
            .field("authority", &self.authority)
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Owners {
    pub input: Option<String>,
    pub focus: Option<String>,
    pub geometry: Option<String>,
}
impl Owners {
    pub fn get(&self, a: Authority) -> Option<&str> {
        match a {
            Authority::Input => self.input.as_deref(),
            Authority::Focus => self.focus.as_deref(),
            Authority::Geometry => self.geometry.as_deref(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Surface {
    Web,
    Opentui,
    Cli,
    Sdk,
    NativeTmux,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    Foreground,
    Background,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientPresence {
    pub client_id: String,
    pub surface: Surface,
    pub state: Presence,
    pub connected_revision: u64,
    pub activity_revision: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub generation: String,
    pub session: String,
    pub revision: u64,
    pub owners: Owners,
    pub native_geometry_yield_until_ms: f64,
    pub clients: Vec<ClientPresence>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptStatus {
    Granted,
    Released,
    Rejected,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ViewportOutcome {
    Ok,
    GeometryAuthorityConflict,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Event {
    SemanticIntentAck {
        #[serde(rename = "operationId")]
        operation_id: String,
        outcome: super::IntentOutcome,
    },
    AuthoritySnapshot {
        snapshot: Snapshot,
    },
    AuthorityReceipt {
        #[serde(rename = "requestId")]
        request_id: String,
        authority: Authority,
        status: ReceiptStatus,
        lease: Option<Lease>,
        snapshot: Snapshot,
    },
    InputAck {
        pane: String,
        seq: u32,
    },
    ViewportAck {
        seq: u32,
        cols: u16,
        rows: u16,
        outcome: ViewportOutcome,
        #[serde(rename = "authorityLease")]
        authority_lease: Lease,
    },
    Error {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        code: String,
        retryable: bool,
    },
}
#[derive(Clone)]
pub enum Input {
    Text(String),
    Key(String),
    /// Exact hexadecimal bytes, negotiated by capability 106 (1..=1024 bytes).
    Bytes(String),
}
impl std::fmt::Debug for Input {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Input([redacted])")
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputResult {
    Ok,
    AuthorityLost,
    Timeout,
    Retired,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputCompletion {
    pub pane: String,
    pub sequence: u32,
    pub result: InputResult,
}
#[derive(Debug, Default)]
pub struct Outcome {
    pub inputs: Vec<InputCompletion>,
    pub authority_changed: bool,
    pub viewport: Option<(u32, ViewportOutcome)>,
    pub intent: Option<super::IntentCompletion>,
}
/// Opaque protocol command. Never log its contents (it may contain terminal text or a lease).
pub struct Command(pub(super) String);
impl Command {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn into_json(self) -> String {
        self.0
    }
}
impl std::fmt::Debug for Command {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Command([redacted])")
    }
}

#[derive(Debug, Default)]
pub struct Expiration {
    pub inputs: Vec<InputCompletion>,
    pub authorities: Vec<(String, Authority)>,
    pub viewports: Vec<u32>,
    pub intents: Vec<String>,
}
