//! tmux-ide owner discovery. Call only on a background worker, never the UI thread.
//! A local URL is not local-file authority: only a verified private record is.
mod agent_observation_pool;
pub use agent_observation_pool::{
    AgentObservationError, AgentObservationEvent, AgentObservationPool, AgentObservationPoolError,
    AgentObservationRequest, MAX_AGENT_OBSERVATION_SESSIONS,
};
mod agent_observation;
pub use agent_observation::{
    AgentActivity, AgentObservation, AgentSelection, ObservedAgent, ObservedHarness,
    ObservedNativePane, ObservedPaneEndpoint, ObservedTeam, ObservedTeamSource, OpenedAgent,
};
mod capability;
mod native_surface_capability;
mod surface_context;
mod surface_provider;
pub use surface_context::{NativeSurfaceContext, NativeSurfaceLocation};
mod surface_provider_ledger;
pub use surface_provider::{SurfaceProvider, SurfaceProviderError};
mod catalog;
mod catalog_events;
mod catalog_recovery;
#[cfg(unix)]
mod local_setup;
#[cfg(unix)]
pub use local_setup::{LocalSetupError, LocalSetupInstallation, resolve_local_setup};
mod catalog_watch_endpoint;
#[cfg(unix)]
pub(crate) use catalog_watch_endpoint::CatalogWatchEndpoint;
mod catalog_watch;
pub use catalog::{CatalogIdentity, CatalogSnapshot};
pub use catalog_events::{
    CatalogEventEffect, CatalogEventError, CatalogEventIdentity, CatalogEvents,
};
pub use catalog_watch::{CatalogWatchError, CatalogWatchWorker};
mod create_pane;
mod create_session;
mod local_session;
pub use capability::{IssueCode, TerminalSelection};
pub use create_pane::{
    AgentHarness, CreatedPane, CreatedPaneResource, NewPane, PaneCreateOutcome, PaneCreation,
    PaneKind,
};
pub use local_session::LocalSessionProof;
mod browser_controls;
pub use browser_controls::{BrowserAction, BrowserCommand, BrowserState};
mod editor;
mod editor_launch;
mod history;
pub use editor::{EditorContext, EditorTarget};
mod inventory;
mod machine_watch;
mod machine_watch_worker;
pub use machine_watch_worker::MachineWatchWorker;
#[cfg(unix)]
mod fleet_registry;
#[cfg(unix)]
pub use fleet_registry::{FleetRegistry, FleetRegistryError};
mod fleet_pool;
pub use fleet_pool::{FleetCatalogEvent, FleetCatalogPool, FleetPoolError};
mod fleet_catalog;
pub use fleet_catalog::{FleetCatalog, FleetCatalogSessions};
mod fleet_environments;
pub use fleet_environments::{
    FleetEnvironmentGroup, FleetEnvironmentRoute, group_fleet_environments,
};
mod fleet_preferences;
mod machine_add;
mod machines;
pub use fleet_preferences::{
    FleetCachedRoute, FleetCachedSession, FleetClientState, FleetPreferenceChange,
};
pub use machine_add::PreparedMachine;
pub use machine_watch::{MachineWatchCancellation, MachineWatchUpdate};
mod open_session;
mod owner;
mod source;
pub use machines::{MachineChange, MachinePatch, SavedMachine, SavedMachineRegistry};
pub use source::CatalogSource;
mod record;
mod servers;
mod sessions;
mod split_layout;
mod worker;
pub use create_session::{CreateOutcome, CreatedSession};
use serde::Deserialize;
pub use servers::ServerRegistration;
pub use sessions::{Favicon, ServerClient, Session};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use url::Url;
pub use worker::{CatalogAction, CatalogResult, CatalogRetirement, CatalogWorker, WorkerError};

const WIRE_VERSION: u32 = 4;
const LIMIT: u64 = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Catalog notification stream failed")]
    CatalogWatch(#[source] Box<CatalogWatchError>),
    #[error("Fleet preference outcome is unconfirmed; refresh before trying again")]
    FleetMutationUncertain(#[source] Box<Error>),
    #[error("Saved machines changed; refresh before trying again")]
    MachineRegistryChanged,
    #[error("Machine change outcome is unconfirmed; refresh before trying again")]
    MachineMutationUncertain(#[source] Box<Error>),
    #[error("This operation requires trusted local daemon provenance")]
    LocalAuthorityRequired,
    #[cfg(unix)]
    #[error("Remote daemon operation failed")]
    Remote(#[source] Box<crate::tmux_ssh::TransportError>),
    #[error("Created pane is not yet attachable; reconcile before retrying")]
    PaneNotReady,
    #[error("Editor launcher IO failed")]
    EditorLaunchIo(#[source] std::io::Error),
    #[error("Editor launch failed")]
    EditorLaunchFailed,
    #[error("Editor action expired")]
    EditorLaunchExpired,
    #[error("invalid history metadata")]
    History(#[source] crate::tmux_history::Error),
    #[error("invalid native control resource")]
    Control(#[source] crate::tmux_control::Error),
    #[error("Local daemon record could not be read")]
    RecordIo(#[source] std::io::Error),
    #[error("Local daemon record is not private or changed while reading")]
    RecordSecurity,
    #[error("Local daemon record is invalid or reserved")]
    RecordFormat,
    #[error("Local daemon record changed; refresh discovery")]
    RecordChanged,
    #[error("Local daemon endpoint must be loopback HTTP")]
    Endpoint,
    #[error("Local daemon could not be reached")]
    Network(#[source] ureq::Error),
    #[error("Local daemon identity response is invalid")]
    IdentityFormat,
    #[error("Local daemon identity changed; refresh discovery")]
    IdentityChanged,
    #[error("Daemon protocol {0} is incompatible; this client requires protocol 4")]
    Incompatible(u32),
    #[error("Daemon owner resource is invalid")]
    ResourceFormat,
    #[error("Daemon owner request failed with HTTP {0}")]
    RequestStatus(u16),
    #[error("Selected tmux server generation is no longer current")]
    ServerChanged,
    #[error("Invalid native terminal selection")]
    TerminalSelection,
    #[error("Native terminal capability was refused ({code:?})")]
    StreamRefused { code: IssueCode, retryable: bool },
    #[error("Invalid native terminal capability")]
    Capability(#[source] crate::tmux_stream::Error),
    #[error("Invalid native owner request")]
    ActionInput,
    #[error("Session action {operation_id} has an unconfirmed outcome; reconcile before retrying")]
    ActionUncertain {
        operation_id: uuid::Uuid,
        #[source]
        source: Box<Error>,
    },
    #[error("Native owner client was retired")]
    Retired,
    #[error("Private daemon record verification is unavailable on this platform")]
    UnsupportedPlatform,
    #[error("The local daemon process has exited")]
    OwnerExited,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    ok: bool,
    pid: u32,
    protocol_version: u32,
    product_version: String,
    instance_id: String,
    started_at: String,
    #[serde(default, deserialize_with = "optional_string")]
    environment_id: Option<String>,
}

/// Process-private acknowledgement of one exact local record, including its
/// credentials and endpoint. Never serialized into GUI messages or peer data.
#[derive(Clone, PartialEq, Eq)]
pub struct LocalOwnerStamp([u8; 32]);

/// Verified private local discovery; contains credentials and is never serialized.
pub struct LocalDaemon {
    path: PathBuf,
    record: record::Record,
    fingerprint: [u8; 32],
    base_url: Url,
    agent: ureq::Agent,
}

impl LocalDaemon {
    pub(super) fn owner_stamp(&self) -> LocalOwnerStamp {
        LocalOwnerStamp(self.fingerprint)
    }

    /// Read-only: does not bootstrap, repair, replace or signal a user's daemon.
    pub fn discover(path: &Path) -> Result<Self, Error> {
        let (record, fingerprint) = record::read(path)?;
        let base_url = record.endpoint()?;
        let candidate = Self {
            path: path.to_path_buf(),
            record,
            fingerprint,
            base_url,
            agent: agent(),
        };
        candidate.verify_current()?;
        Ok(candidate)
    }

    pub fn product_version(&self) -> &str {
        &self.record.product_version
    }
    pub fn instance_id(&self) -> &str {
        &self.record.instance_id
    }

    /// Prove the captured owner before issuing a credential-bearing request.
    /// The private record is re-read and its pid checked every time, so a
    /// restarted or exited daemon is never trusted on an old proof. One
    /// `/identity` proof serves a daemon generation for at most `PROOF_AGE`,
    /// and until any request to it fails, which drops the proof (#703).
    pub fn verify_current(&self) -> Result<(), Error> {
        self.check_record()?;
        if proven(&self.fingerprint) {
            return Ok(());
        }
        let (epoch, started) = (proof_epoch(), Instant::now());
        let result = self.prove_identity();
        if result.is_ok() {
            prove(self.fingerprint, epoch, started);
        } else {
            disprove(&self.fingerprint);
        }
        result
    }
    fn prove_identity(&self) -> Result<(), Error> {
        let endpoint = self
            .base_url
            .join("identity")
            .map_err(|_| Error::Endpoint)?;
        let mut response = self
            .agent
            .get(endpoint.as_str())
            .call()
            .map_err(Error::Network)?;
        if response.status().as_u16() != 200 {
            return Err(Error::IdentityFormat);
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(LIMIT)
            .read_to_vec()
            .map_err(Error::Network)?;
        let identity: Identity =
            serde_json::from_slice(&bytes).map_err(|_| Error::IdentityFormat)?;
        if !identity.ok || identity.product_version.trim().is_empty() {
            return Err(Error::IdentityFormat);
        }
        if identity.pid != self.record.pid
            || identity.protocol_version != self.record.protocol_version
            || identity.instance_id != self.record.instance_id
            || identity.started_at != self.record.started_at
            || identity.environment_id != self.record.environment_id
        {
            return Err(Error::IdentityChanged);
        }
        if identity.protocol_version != WIRE_VERSION {
            return Err(Error::Incompatible(identity.protocol_version));
        }
        self.check_record()
    }

    // Fixed call sites choose resource paths; peer data never controls the host.
    fn get_resource(&self, path: &str) -> Result<Vec<u8>, Error> {
        self.check_record()?;
        let endpoint = self.base_url.join(path).map_err(|_| Error::Endpoint)?;
        if endpoint.origin() != self.base_url.origin() {
            return Err(Error::Endpoint);
        }
        let mut response = self
            .agent
            .get(endpoint.as_str())
            .header("Authorization", self.record.authorization()?)
            .header("Cache-Control", "no-store")
            .call()
            .map_err(|error| self.failed(Error::Network(error)))?;
        if response.status().as_u16() != 200 {
            return Err(self.failed(Error::RequestStatus(response.status().as_u16())));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_vec()
            .map_err(|error| self.failed(Error::Network(error)))?;
        self.check_record()?;
        Ok(bytes)
    }

    // Mutations are sent once. A transport failure may follow a committed action.
    fn post_resource_with_options(
        &self,
        path: &str,
        body: &[u8],
        headers: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<Vec<u8>, Error> {
        self.write_resource_with_options(path, body, headers, timeout, false)
    }
    fn write_resource_with_options(
        &self,
        path: &str,
        body: &[u8],
        headers: &[(&str, &str)],
        timeout: Duration,
        patch: bool,
    ) -> Result<Vec<u8>, Error> {
        self.check_record()?;
        let endpoint = self.base_url.join(path).map_err(|_| Error::Endpoint)?;
        if endpoint.origin() != self.base_url.origin() {
            return Err(Error::Endpoint);
        }
        let request = if patch {
            self.agent.patch(endpoint.as_str())
        } else {
            self.agent.post(endpoint.as_str())
        };
        let mut request = request
            .header("Authorization", self.record.authorization()?)
            .header("Content-Type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let mut response = request
            .config()
            .timeout_global(Some(timeout))
            .build()
            .send(body)
            .map_err(|error| self.failed(Error::Network(error)))?;
        if response.status().as_u16() != 200 {
            return Err(self.failed(Error::RequestStatus(response.status().as_u16())));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_vec()
            .map_err(|error| self.failed(Error::Network(error)))?;
        self.check_record()?;
        Ok(bytes)
    }

    fn check_record(&self) -> Result<(), Error> {
        let (_, fingerprint) = record::read(&self.path)?;
        if fingerprint != self.fingerprint {
            disprove(&self.fingerprint);
            return Err(Error::RecordChanged);
        }
        // A daemon that died without a new record leaves its port free for any
        // local process: no credential goes out once its pid is gone.
        if !owner_alive(self.record.pid) {
            disprove(&self.fingerprint);
            return Err(Error::OwnerExited);
        }
        Ok(())
    }
    /// A failed request drops this generation's proof before reporting it.
    pub(super) fn failed(&self, error: Error) -> Error {
        disprove(&self.fingerprint);
        error
    }
}

/// The local daemon generation (its record fingerprint) last proven by
/// `/identity` in this process, and when that probe started. Process-wide, so
/// every worker that discovers the same daemon shares one proof. `disproofs`
/// counts failures: a probe that overlapped one never records its proof.
struct Proof {
    proven: Option<([u8; 32], Instant)>,
    disproofs: u64,
}
static PROOF: std::sync::Mutex<Proof> = std::sync::Mutex::new(Proof {
    proven: None,
    disproofs: 0,
});
/// A proof older than this is probed again, so a daemon that died silently
/// and a squatter on its port are caught within this window (#703, PM).
const PROOF_AGE: Duration = Duration::from_secs(5);
fn proven(fingerprint: &[u8; 32]) -> bool {
    caching()
        && PROOF.lock().is_ok_and(|proof| {
            proof
                .proven
                .is_some_and(|(proven, at)| proven == *fingerprint && at.elapsed() < PROOF_AGE)
        })
}
// This crate's scripted-peer tests expect one `/identity` per call and use
// made-up pids; a test opts in to the cache and the pid check on its own
// thread. Every other build always does both.
#[cfg(test)]
thread_local! {
    pub(super) static IDENTITY_CACHE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static PID_CHECK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
fn caching() -> bool {
    #[cfg(test)]
    {
        IDENTITY_CACHE.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        true
    }
}
fn proof_epoch() -> Option<u64> {
    PROOF.lock().ok().map(|proof| proof.disproofs)
}
fn prove(fingerprint: [u8; 32], epoch: Option<u64>, started: Instant) {
    if caching()
        && let Ok(mut proof) = PROOF.lock()
        && epoch == Some(proof.disproofs)
    {
        proof.proven = Some((fingerprint, started));
    }
}
fn disprove(fingerprint: &[u8; 32]) {
    if caching()
        && let Ok(mut proof) = PROOF.lock()
    {
        proof.disproofs = proof.disproofs.wrapping_add(1);
        if proof
            .proven
            .is_some_and(|(proven, _)| proven == *fingerprint)
        {
            proof.proven = None;
        }
    }
}
/// `kill(pid, 0)`: only "no such process" counts as gone; a pid owned by
/// another user still exists.
fn owner_alive(pid: u32) -> bool {
    #[cfg(test)]
    if !PID_CHECK.with(std::cell::Cell::get) {
        return true;
    }
    #[cfg(unix)]
    {
        let Some(pid) = i32::try_from(pid)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return false;
        };
        !matches!(
            rustix::process::test_kill_process(pid),
            Err(rustix::io::Errno::SRCH)
        )
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}
fn optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

/// Daemon HTTP requests this process has sent through the catalog agent, for
/// request fan-out checks (#702, #703). Never a request's content: only a count
/// and the last paths with every id-like segment masked.
static REQUESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RECENT: std::sync::Mutex<std::collections::VecDeque<(u64, String)>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
pub fn requests_sent() -> u64 {
    REQUESTS.load(std::sync::atomic::Ordering::Relaxed)
}
/// The masked paths of requests numbered above `after`, oldest first (at most 64).
pub fn requests_since(after: u64) -> Vec<String> {
    RECENT.lock().map_or_else(
        |_| Vec::new(),
        |recent| {
            recent
                .iter()
                .filter(|(n, _)| *n > after)
                .map(|(_, path)| path.clone())
                .collect()
        },
    )
}
fn count_request(path: &str) {
    let n = REQUESTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let masked = path
        .split('/')
        .map(|segment| {
            let plain =
                segment.len() <= 24 && segment.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
            if plain { segment } else { ":" }
        })
        .collect::<Vec<_>>()
        .join("/");
    if let Ok(mut recent) = RECENT.lock() {
        if recent.len() >= 64 {
            recent.pop_front();
        }
        recent.push_back((n, masked));
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .middleware(
            |request: ureq::http::Request<ureq::SendBody<'_>>,
             next: ureq::middleware::MiddlewareNext<'_>| {
                count_request(request.uri().path());
                next.handle(request)
            },
        )
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_millis(2500)))
        .build()
        .into()
}

#[cfg(all(test, unix))]
#[path = "tests.rs"]
mod tests;

mod config_namespace;
pub use config_namespace::LocalConfigNamespace;
