//! The Daytona REST calls this app makes, typed: list, read, create, and
//! start sandboxes, and issue a short-lived SSH token for one. Readiness maps
//! Daytona's sandbox states onto what adding or connecting needs to know.

use super::{Error, Result, http::Request};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

const START_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const POLL: Duration = Duration::from_secs(3);
const LIST_LIMIT: usize = 100;
/// How long an SSH token stays usable. It is only needed to open the
/// connection; an open session outlives it.
const SSH_TOKEN_MINUTES: u32 = 10;
/// The label that marks sandboxes this app created.
const LABEL: &str = "herdr.dev/device";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sandbox {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) error_reason: Option<String>,
}

/// What a sandbox's state means for using it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Readiness {
    Ready,
    /// Stopped, archived, or paused: starting it brings it back.
    Stopped,
    /// Daytona's own word for where it is, e.g. `pulling_snapshot`.
    Pending(String),
    Failed(String),
    Deleted,
}

impl Sandbox {
    pub(crate) fn readiness(&self) -> Readiness {
        match self.state.as_str() {
            "started" => Readiness::Ready,
            "stopped" | "archived" | "paused" => Readiness::Stopped,
            "error" | "build_failed" => Readiness::Failed(
                self.error_reason
                    .clone()
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or_else(|| self.state.clone()),
            ),
            "destroyed" | "destroying" => Readiness::Deleted,
            other => Readiness::Pending(other.replace('_', " ")),
        }
    }
}

/// Newer API versions page the list; older ones returned a bare array.
#[derive(Deserialize)]
#[serde(untagged)]
enum List {
    Page { items: Vec<Sandbox> },
    All(Vec<Sandbox>),
}

#[derive(Serialize)]
struct Create<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<&'a str>,
    labels: BTreeMap<&'a str, &'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshAccess {
    pub(crate) token: SecretString,
    /// e.g. `ssh <token>@ssh.app.daytona.io` or `ssh -p 2222 <token>@host`.
    pub(crate) ssh_command: SecretString,
}

/// Sandbox IDs come from the API and go back into paths.
fn segment(id: &str) -> Result<&str> {
    if !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        Ok(id)
    } else {
        Err(Error::Field("Daytona sandbox ID"))
    }
}

impl Request<'_> {
    pub(crate) fn sandboxes(&self) -> Result<Vec<Sandbox>> {
        let list: List = self.get("sandboxes", &format!("/sandbox?limit={LIST_LIMIT}"))?;
        Ok(match list {
            List::Page { items } | List::All(items) => items,
        })
    }

    /// The sandbox with `id`; one that no longer exists is `Error::Deleted`.
    pub(crate) fn sandbox(&self, id: &str) -> Result<Sandbox> {
        self.get("sandbox", &format!("/sandbox/{}", segment(id)?))
            .map_err(|error| match error {
                Error::Status(super::Status { code: 404, .. }) => Error::Deleted,
                error => error,
            })
    }

    pub(crate) fn create(&self, name: &str) -> Result<Sandbox> {
        let settings = self.settings;
        self.post(
            "create_sandbox",
            "/sandbox",
            &Create {
                name,
                snapshot: settings.snapshot.as_deref(),
                target: settings.target.as_deref(),
                labels: BTreeMap::from([(LABEL, "true")]),
            },
        )
    }

    pub(crate) fn start(&self, id: &str) -> Result<()> {
        self.post_empty("start_sandbox", &format!("/sandbox/{}/start", segment(id)?))
    }

    pub(crate) fn ssh_access(&self, id: &str) -> Result<SshAccess> {
        self.post(
            "ssh_access",
            &format!(
                "/sandbox/{}/ssh-access?expiresInMinutes={SSH_TOKEN_MINUTES}",
                segment(id)?
            ),
            &serde_json::json!({}),
        )
    }
}

/// Wait until the sandbox is started, starting it once if it is stopped.
/// `progress` hears each state it passes through.
pub(crate) fn wait_ready(
    request: &Request,
    id: &str,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(&Readiness),
) -> Result<Sandbox> {
    let deadline = Instant::now() + START_TIMEOUT;
    let mut started = false;
    loop {
        if cancelled() {
            return Err(Error::Cancelled);
        }
        let sandbox = request.sandbox(id)?;
        let readiness = sandbox.readiness();
        match &readiness {
            Readiness::Ready => return Ok(sandbox),
            Readiness::Failed(reason) => return Err(Error::Sandbox(reason.clone())),
            Readiness::Deleted => return Err(Error::Deleted),
            Readiness::Stopped if !started => {
                started = true;
                request.start(id)?;
            }
            Readiness::Stopped | Readiness::Pending(_) => {}
        }
        progress(&readiness);
        if Instant::now() >= deadline {
            return Err(Error::StartTimeout);
        }
        // Sleep in short steps so cancellation is observed promptly.
        let wake = Instant::now() + POLL;
        while Instant::now() < wake {
            if cancelled() {
                return Err(Error::Cancelled);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(test)]
mod tests;
