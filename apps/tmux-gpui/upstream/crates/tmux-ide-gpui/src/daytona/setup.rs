//! The blocking jobs behind Daytona's tab and its device picker row: create a
//! sandbox, wait for it, check for (and on approval install) Herdr, and save
//! the device; and what the Settings tab shows about the account.

use super::{
    Result, Settings,
    api::{self, Readiness},
    connect, gateway,
    http::Request,
    store,
};
use crate::cloud::{self, CloudProvider, SavedDevice, install};
use crate::github::Store;
use secrecy::SecretString;

/// The session every Daytona device attaches to.
const SESSION: &str = "default";
/// Daytona allows longer names; this keeps them readable in the sidebar.
const NAME_LIMIT: usize = 40;

/// What adding a Daytona sandbox needs.
pub(crate) struct AddRequest {
    pub(crate) settings: Settings,
    pub(crate) name: String,
    /// The user approved running Herdr's installer if the sandbox lacks it.
    pub(crate) install: bool,
}

/// A default name for a new sandbox.
pub(crate) fn random_name() -> String {
    cloud::names::random("herdr", NAME_LIMIT)
}

fn step(readiness: &Readiness) -> cloud::Step {
    match readiness {
        Readiness::Pending(state) => cloud::Step::Building(state.clone()),
        _ => cloud::Step::Starting,
    }
}

/// The whole job for `cloud::Jobs`: create, wait, install if approved and
/// needed, and save the device.
pub(crate) fn add_device(
    request: AddRequest,
    cancelled: &dyn Fn() -> bool,
    report: &dyn Fn(cloud::Step),
) -> crate::Result<SavedDevice> {
    let AddRequest {
        settings,
        name,
        install,
    } = request;
    // Fail before creating anything when the transport cannot run later.
    gateway::check_ssh()?;
    let key = store::key(&settings)?;
    let request = Request {
        settings: &settings,
        key: &key,
    };
    report(cloud::Step::Creating);
    let created = request.create(&name)?;
    let sandbox = api::wait_ready(&request, &created.id, cancelled, |readiness| {
        report(step(readiness));
    })?;
    report(cloud::Step::CheckingHerdr);
    // Each `ssh` run gets its own gateway file, removed once the run ends.
    let installed = install::installed(connect::gateway(&request, &sandbox)?.command, &cancelled)?;
    if !installed {
        if !install {
            return Err(cloud::Error::Install(format!(
                "Herdr is not installed in {}; add it and try again",
                sandbox.name
            ))
            .into());
        }
        report(cloud::Step::InstallingHerdr);
        install::install(connect::gateway(&request, &sandbox)?.command, &cancelled)?;
        // The installer's own success is not proof the bridge will find it.
        if !install::installed(connect::gateway(&request, &sandbox)?.command, &cancelled)? {
            return Err(cloud::Error::Install(
                "the installer finished but Herdr is not on the expected paths".into(),
            )
            .into());
        }
    }
    let device = SavedDevice {
        provider: CloudProvider::Daytona,
        id: sandbox.id,
        label: sandbox.name.clone(),
        account: settings.base.clone(),
        machine: sandbox.name,
        session: SESSION.to_owned(),
        enabled: true,
    };
    cloud::save(device.clone())?;
    Ok(device)
}

/// Where the API key in use comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Key {
    Missing,
    Saved,
    Environment,
}

/// What the Settings tab shows about an account.
#[derive(Debug)]
pub(crate) struct Overview {
    pub(crate) key: Key,
    /// How many sandboxes the key can see, or why that could not be read.
    pub(crate) sandboxes: Option<Result<usize>>,
    /// This account's saved devices.
    pub(crate) devices: Vec<SavedDevice>,
}

pub(crate) fn overview(settings: &Settings) -> Result<Overview> {
    let devices = cloud::load()?
        .into_iter()
        .filter(|saved| saved.provider == CloudProvider::Daytona && saved.account == settings.base)
        .collect();
    let key = if std::env::var_os(store::VARIABLE).is_some() {
        Key::Environment
    } else if store::saved(settings.store)?.is_some() {
        Key::Saved
    } else {
        Key::Missing
    };
    let sandboxes = (key != Key::Missing).then(|| {
        let key = store::key(settings)?;
        Request {
            settings,
            key: &key,
        }
        .sandboxes()
        .map(|sandboxes| sandboxes.len())
    });
    Ok(Overview {
        key,
        sandboxes,
        devices,
    })
}

/// Save (or with `None`, forget) the API key typed into Settings.
pub(crate) fn save_key(store: Store, key: Option<&SecretString>) -> Result<()> {
    store::save(store, key)
}

/// Forget one saved device; its sandbox is left untouched in Daytona.
pub(crate) fn forget_device(id: &str) -> Result<()> {
    Ok(cloud::remove(CloudProvider::Daytona, id)?)
}
