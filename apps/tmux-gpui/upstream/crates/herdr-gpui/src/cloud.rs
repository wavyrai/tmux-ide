//! Machines cloud providers create and this app uses as devices. What every
//! provider shares lives here: the saved device list, the background jobs that
//! add machines (with their progress and toasts), and the connector that hands
//! a cloud target to its provider. Each provider module (only `coder` so far)
//! owns its API, sign-in, readiness rules, and the command that reaches a
//! machine; supporting another one adds a `CloudProvider` variant and a module.

mod catalog;
pub(crate) mod install;
mod jobs;
pub(crate) mod names;
pub(crate) mod worker;

pub(crate) use catalog::{SavedDevice, load, remove, save};
pub(crate) use herdr_client::CloudProvider;
pub(crate) use jobs::Jobs;

use herdr_client::{ConnectTarget, Transport};
use std::{io, path::PathBuf, sync::atomic::AtomicBool};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Could not update {}: {source}", path.display())]
    Catalog {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Invalid saved cloud devices.")]
    Json(#[source] serde_json::Error),
    #[error("{0} is not valid.")]
    Invalid(&'static str),
    #[error("No state directory for saved cloud devices.")]
    StateDirectory,
    #[error("The cloud {0} worker stopped.")]
    Worker(&'static str),
    #[error("Could not run the command that reaches the machine.")]
    Process(#[source] io::Error),
    #[error("Cancelled.")]
    Cancelled,
    #[error("Installing Herdr failed: {0}")]
    Install(String),
    #[error("Installing Herdr did not finish within 5 minutes.")]
    InstallTimeout,
    #[error("{0}")]
    Unavailable(&'static str),
}

/// Why cloud machines cannot be used on this system, if they cannot. Each is
/// reached by running Herdr's bridge over a provider command's standard
/// streams, which only the Unix client supports; offering setup elsewhere
/// would save devices that can never connect.
pub(crate) fn unavailable() -> Option<&'static str> {
    cfg!(windows).then_some("Cloud devices are unavailable on Windows.")
}

/// What a job reports while it adds a machine, in words every provider shares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Creating,
    Starting,
    /// The provider's own word for where the build is, e.g. `pending`.
    Building(String),
    CheckingHerdr,
    InstallingHerdr,
}

impl Step {
    pub(crate) fn text(&self) -> String {
        match self {
            Self::Creating => "Creating…".into(),
            Self::Starting => "Starting…".into(),
            Self::Building(status) => format!("Building ({status})…"),
            Self::CheckingHerdr => "Checking for Herdr…".into(),
            Self::InstallingHerdr => "Installing Herdr…".into(),
        }
    }
}

/// The provider's name, as the UI shows it.
pub(crate) fn name(provider: CloudProvider) -> &'static str {
    match provider {
        #[cfg(feature = "coder")]
        CloudProvider::Coder => "Coder",
        #[cfg(feature = "daytona")]
        CloudProvider::Daytona => "Daytona",
    }
}

/// What the device picker's row for the provider offers.
pub(crate) fn offer(provider: CloudProvider) -> &'static str {
    match provider {
        #[cfg(feature = "coder")]
        CloudProvider::Coder => "Create or attach a Coder workspace",
        // Its row opens Settings, where sandboxes are created; existing ones
        // cannot be attached yet.
        #[cfg(feature = "daytona")]
        CloudProvider::Daytona => "Create a Daytona sandbox in Settings",
    }
}

/// What the provider calls one machine.
pub(crate) fn noun(provider: CloudProvider) -> &'static str {
    match provider {
        #[cfg(feature = "coder")]
        CloudProvider::Coder => "workspace",
        #[cfg(feature = "daytona")]
        CloudProvider::Daytona => "sandbox",
    }
}

/// The connector for `ConnectTarget::Cloud`: the provider makes the machine
/// ready and spawns the bridge command. Runs on the connection worker.
pub(crate) fn connect(target: &ConnectTarget, stop: &AtomicBool) -> io::Result<Transport> {
    let ConnectTarget::Cloud {
        provider,
        account,
        id,
        session,
        ..
    } = target
    else {
        return Err(io::Error::other(Error::Invalid("cloud target")));
    };
    match provider {
        #[cfg(feature = "coder")]
        CloudProvider::Coder => crate::coder::connect(account, id, session, stop),
        #[cfg(feature = "daytona")]
        CloudProvider::Daytona => crate::daytona::connect(account, id, session, stop),
    }
}

#[cfg(test)]
pub(crate) mod tests;
