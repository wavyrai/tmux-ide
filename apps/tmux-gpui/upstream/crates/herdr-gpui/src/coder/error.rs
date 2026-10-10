//! Coder failures keep their category and cause until the menu displays them.
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
    #[error("Coder needs {0}. Set it in Settings > Cloud Devices.")]
    Missing(&'static str),
    #[error("Coder sign-in required.")]
    Authentication,
    #[error("Coder denied access. Check your account's permissions for this template.")]
    Forbidden,
    #[error("{0}")]
    Status(#[from] Status),
    #[error("Coder network request failed or timed out.")]
    Network(#[source] ureq::Error),
    #[error("Coder response could not be read within the size/time limit.")]
    Read(#[source] io::Error),
    #[error("Coder response exceeded the size limit.")]
    Size,
    #[error("Invalid Coder JSON response.")]
    Json(#[source] JsonError),
    #[error("Invalid Coder authorization header.")]
    Header(#[source] ureq::http::header::InvalidHeaderValue),
    #[error("Could not listen for the Coder sign-in redirect on {address}.")]
    Listen {
        address: String,
        #[source]
        source: io::Error,
    },
    #[error("The Coder sign-in redirect could not be read.")]
    Redirect(#[source] io::Error),
    #[error("Coder sign-in was cancelled.")]
    Cancelled,
    #[error("Coder sign-in timed out. Sign in again.")]
    Timeout,
    #[error("Coder did not authorize this sign-in ({0}).")]
    Authorization(String),
    #[error("Invalid Coder token response.")]
    Token,
    #[error("Could not generate a random sign-in secret.")]
    Random(#[source] getrandom::Error),
    #[error("Coder workspace failed: {0}")]
    Workspace(String),
    #[error("The Coder workspace was deleted.")]
    Deleted,
    #[error("The Coder workspace did not become ready within 10 minutes.")]
    BuildTimeout,
    #[error("The coder CLI was not found. Install it or set [coder] cli to its path.")]
    Cli,
    #[error(
        "This device belongs to a Coder deployment that is no longer configured in [coder] url."
    )]
    Deployment,
    #[error("{0}")]
    Bridge(#[source] herdr_client::Error),
    #[error("Could not update {}: {source}", path.display())]
    Catalog {
        path: std::path::PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Cloud(#[from] crate::cloud::Error),
    #[error("{0}")]
    Storage(#[source] Box<crate::Error>),
    #[error("Coder {0} worker stopped.")]
    Worker(&'static str),
}

impl Error {
    pub(crate) fn json(source: serde_json::Error) -> Self {
        Self::Json(JsonError(source))
    }
}

/// A non-success Coder reply. Coder explains failures in `message`/`detail`;
/// both are bounded and stripped of control characters before display.
#[derive(Debug, thiserror::Error)]
#[error("Coder request failed (HTTP {code}){}", message.as_deref().map(|m| format!(": {m}")).unwrap_or_default())]
pub struct Status {
    pub code: u16,
    pub message: Option<String>,
}

/// Parser diagnostics can quote credential-bearing fields; expose the cause only
/// to explicit source inspection, never ordinary Display or Debug formatting.
#[derive(thiserror::Error)]
#[error("Invalid Coder JSON response.")]
pub struct JsonError(#[source] serde_json::Error);

impl std::fmt::Debug for JsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JsonError([REDACTED])")
    }
}
