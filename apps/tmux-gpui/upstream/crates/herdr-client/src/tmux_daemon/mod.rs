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
pub use sessions::{ServerClient, Session};
use std::{
    path::{Path, PathBuf},
    time::Duration,
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

    /// Re-prove the captured owner before issuing a credential-bearing request.
    /// Checking before and after the network operation rejects replacement races.
    pub fn verify_current(&self) -> Result<(), Error> {
        self.check_record()?;
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
            .map_err(Error::Network)?;
        if response.status().as_u16() != 200 {
            return Err(Error::RequestStatus(response.status().as_u16()));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_vec()
            .map_err(Error::Network)?;
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
            .map_err(Error::Network)?;
        if response.status().as_u16() != 200 {
            return Err(Error::RequestStatus(response.status().as_u16()));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_vec()
            .map_err(Error::Network)?;
        self.check_record()?;
        Ok(bytes)
    }

    fn check_record(&self) -> Result<(), Error> {
        let (_, fingerprint) = record::read(&self.path)?;
        if fingerprint != self.fingerprint {
            return Err(Error::RecordChanged);
        }
        Ok(())
    }
}

fn optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
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
