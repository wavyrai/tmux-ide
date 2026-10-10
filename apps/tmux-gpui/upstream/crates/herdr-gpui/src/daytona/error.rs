//! Daytona failures keep their category and cause until the UI displays them.
//! Remote text is bounded diagnostic payload, never a credential.

use std::io;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} must be https (http only on loopback) with no credentials, query, or fragment.")]
    Url(&'static str),
    #[error("{0} is not valid.")]
    Field(&'static str),
    #[error("{0} must be UTF-8.")]
    Encoding(&'static str),
    #[error("Daytona needs an API key. Save one in Settings > Cloud Devices.")]
    MissingKey,
    #[error("Daytona rejected the API key.")]
    Authentication,
    #[error("Daytona denied access. Check the API key's permissions.")]
    Forbidden,
    #[error("{0}")]
    Status(#[from] Status),
    #[error("Daytona network request failed or timed out.")]
    Network(#[source] ureq::Error),
    #[error("Daytona response could not be read within the size/time limit.")]
    Read(#[source] io::Error),
    #[error("Daytona response exceeded the size limit.")]
    Size,
    #[error("Invalid Daytona JSON response.")]
    Json(#[source] serde_json::Error),
    #[error("Invalid Daytona authorization header.")]
    Header(#[source] ureq::http::header::InvalidHeaderValue),
    #[error("Daytona sandbox failed: {0}")]
    Sandbox(String),
    #[error("The Daytona sandbox was deleted.")]
    Deleted,
    #[error("The Daytona sandbox did not start within 10 minutes.")]
    StartTimeout,
    #[error("Cancelled.")]
    Cancelled,
    #[error("Daytona returned an SSH command this app does not understand.")]
    Gateway,
    #[error("Daytona devices need ssh on the PATH; it could not be run.")]
    SshMissing(#[source] io::Error),
    #[error("Could not prepare the SSH command for the Daytona gateway.")]
    GatewayFile(#[source] io::Error),
    #[error(
        "This device belongs to a Daytona account that is no longer configured in [daytona] api_url."
    )]
    Account,
    #[error("{0}")]
    Bridge(#[source] herdr_client::Error),
    #[error(transparent)]
    Cloud(#[from] crate::cloud::Error),
    #[error("{0}")]
    Storage(#[source] Box<crate::Error>),
}

/// A non-success Daytona reply. Daytona explains failures in `message`; it is
/// bounded and stripped of control characters before display.
#[derive(Debug, thiserror::Error)]
#[error("Daytona request failed (HTTP {code}){}", message.as_deref().map(|m| format!(": {m}")).unwrap_or_default())]
pub struct Status {
    pub code: u16,
    pub message: Option<String>,
}
