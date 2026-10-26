use super::Error;
use serde::Deserialize;
/// Untrusted decoded SSH stdout. No Debug/Serialize or public credential accessor.
/// Parsing does not authorize local filesystem access or credential forwarding.
pub struct RemoteDescriptor {
    daemon: Daemon,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteFailure {
    DaemonMissing,
    Incompatible,
    Unavailable,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Success {
    version: u8,
    daemon: Daemon,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure {
    version: u8,
    error: FailureCode,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FailureCode {
    code: RemoteFailure,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Daemon {
    pid: u32,
    port: u16,
    protocol_version: u32,
    product_version: String,
    instance_id: String,
    started_at: String,
    #[serde(default, deserialize_with = "present")]
    environment_id: Option<String>,
    bind_hostname: String,
    auth_token: String,
    #[serde(default, deserialize_with = "present")]
    tmux_server_proof_version: Option<u8>,
    #[serde(default, deserialize_with = "present")]
    supervision_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    provenance: Option<Provenance>,
}
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    launcher: String,
    supervisor: String,
    parent_pid: u64,
    stdout: Log,
    stderr: Log,
    #[serde(default, deserialize_with = "present")]
    warnings: Option<Vec<String>>,
}
#[derive(Deserialize)]
struct Log {
    kind: String,
    #[serde(default, deserialize_with = "present")]
    path: Option<String>,
    #[serde(default, deserialize_with = "present")]
    dev: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    ino: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    detail: Option<String>,
}
fn bounded(value: &str, max: usize) -> bool {
    value.encode_utf16().count() <= max
}
fn uuid(value: &str) -> bool {
    value.len() == 36 && uuid::Uuid::parse_str(value).is_ok()
}
impl Log {
    fn valid(&self) -> bool {
        matches!(
            self.kind.as_str(),
            "file" | "tty" | "pipe" | "socket" | "null" | "unknown"
        ) && self
            .path
            .as_ref()
            .is_none_or(|p| !p.is_empty() && bounded(p, 4096))
            && self.detail.as_ref().is_none_or(|d| bounded(d, 256))
            && self.dev.is_none_or(|n| n <= 9_007_199_254_740_991)
            && self.ino.is_none_or(|n| n <= 9_007_199_254_740_991)
    }
}
impl Provenance {
    fn valid(&self) -> bool {
        matches!(self.launcher.as_str(), "headless" | "embedded")
            && matches!(
                self.supervisor.as_str(),
                "manual" | "launchd" | "systemd" | "embedded"
            )
            && self.parent_pid <= 9_007_199_254_740_991
            && self.stdout.valid()
            && self.stderr.valid()
            && self
                .warnings
                .as_ref()
                .is_none_or(|w| w.len() <= 8 && w.iter().all(|s| bounded(s, 256)))
    }
}
impl RemoteDescriptor {
    pub fn parse(bytes: &[u8], expected_environment: Option<&str>) -> Result<Self, Error> {
        if bytes.len() > 32 * 1024 {
            return Err(Error::Descriptor);
        }
        if let Ok(failure) = serde_json::from_slice::<Failure>(bytes) {
            return if failure.version == 1 {
                Err(Error::Remote(failure.error.code))
            } else {
                Err(Error::Descriptor)
            };
        }
        let Success { version, daemon } =
            serde_json::from_slice(bytes).map_err(|_| Error::Descriptor)?;
        if version != 1
            || daemon.pid == 0
            || daemon.pid > i32::MAX as u32
            || daemon.port == 0
            || daemon.protocol_version == 0
            || daemon.product_version.trim().is_empty()
            || !uuid(&daemon.instance_id)
            || chrono::DateTime::parse_from_rfc3339(&daemon.started_at).is_err()
            || daemon.environment_id.as_ref().is_some_and(|id| !uuid(id))
            || daemon.auth_token.is_empty()
            || !bounded(&daemon.auth_token, 4096)
            || ureq::http::HeaderValue::from_str(&format!("Bearer {}", daemon.auth_token)).is_err()
            || !matches!(
                daemon.bind_hostname.as_str(),
                "127.0.0.1" | "localhost" | "::1" | "0.0.0.0" | "::"
            )
            || daemon.tmux_server_proof_version.is_some_and(|v| v != 1)
            || daemon.supervision_id.as_ref().is_some_and(|id| {
                id.is_empty()
                    || id.len() > 128
                    || !id.as_bytes()[0].is_ascii_alphanumeric()
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            })
            || daemon.provenance.as_ref().is_some_and(|p| !p.valid())
        {
            return Err(Error::Descriptor);
        }
        if daemon.protocol_version != 4 {
            return Err(Error::Incompatible(daemon.protocol_version));
        }
        if let Some(expected) = expected_environment
            && (!uuid(expected)
                || !daemon
                    .environment_id
                    .as_ref()
                    .is_some_and(|actual| actual.eq_ignore_ascii_case(expected)))
        {
            return Err(Error::Environment);
        }
        Ok(Self { daemon })
    }
    #[cfg(unix)]
    pub(super) fn catalog_identity(&self) -> crate::tmux_daemon::CatalogEventIdentity {
        crate::tmux_daemon::CatalogEventIdentity {
            protocol_version: self.daemon.protocol_version,
            product_version: self.daemon.product_version.clone(),
            instance_id: self.daemon.instance_id.clone(),
            started_at: self.daemon.started_at.clone(),
            environment_id: self.daemon.environment_id.clone(),
        }
    }
    pub fn peer_identity(&self) -> PeerIdentity {
        PeerIdentity {
            pid: self.daemon.pid,
            protocol_version: self.daemon.protocol_version,
            product_version: self.daemon.product_version.clone(),
            instance_id: self.daemon.instance_id.clone(),
            started_at: self.daemon.started_at.clone(),
            environment_id: self.daemon.environment_id.clone(),
        }
    }
    pub(super) fn matches_identity(&self, bytes: &[u8]) -> bool {
        self.peer_identity().matches(bytes)
    }
    pub(super) fn authorization(&self) -> String {
        format!("Bearer {}", self.daemon.auth_token)
    }
    pub fn instance_id(&self) -> &str {
        &self.daemon.instance_id
    }
    pub fn environment_id(&self) -> Option<&str> {
        self.daemon.environment_id.as_deref()
    }
    pub fn product_version(&self) -> &str {
        self.daemon.product_version.trim()
    }
    pub(super) fn forward_target(&self) -> String {
        let host = match self.daemon.bind_hostname.as_str() {
            "::" | "::1" => "[::1]",
            "localhost" => "localhost",
            _ => "127.0.0.1",
        };
        format!("{host}:{}", self.daemon.port)
    }
}
/// Credential-free expected peer identity. This grants no filesystem authority.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerIdentity {
    pid: u32,
    protocol_version: u32,
    product_version: String,
    instance_id: String,
    started_at: String,
    #[serde(default, deserialize_with = "present")]
    environment_id: Option<String>,
}
impl PeerIdentity {
    pub(super) fn matches(&self, bytes: &[u8]) -> bool {
        #[derive(Deserialize)]
        struct Response {
            ok: bool,
            #[serde(flatten)]
            identity: PeerIdentity,
        }
        serde_json::from_slice::<Response>(bytes)
            .is_ok_and(|response| response.ok && response.identity == *self)
    }
}
#[cfg(test)]
#[path = "descriptor_tests.rs"]
mod tests;
