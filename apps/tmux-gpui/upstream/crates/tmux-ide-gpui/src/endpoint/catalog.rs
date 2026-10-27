//! The saved-host catalog: background loads of the saved devices, the
//! serialized writes of this client's host selection, and reconciling the
//! window's endpoints and selection with what the catalog says. SSH devices
//! come from upstream's endpoint catalog; WSL distributions from this client's
//! own list beside it, which upstream never reads.
use super::{Endpoint, LOCAL, SAVED_PREFIX, WSL_PREFIX};
use crate::{Error, HerdrWindow, Result, storage_warning::StorageFailure};
use gpui::Context;
use herdr_client::{ConnectTarget, SavedHost, WslHost};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) struct Catalog {
    development: Option<bool>,
    pending: Option<mpsc::Receiver<Result<CatalogUpdate>>>,
    next_poll: Instant,
    /// The endpoint ID to restore, or `None` for Local.
    pub(super) desired: Option<String>,
    pub(super) initialized: bool,
    pub(super) restore_pending: bool,
    pub(super) queued_write: Option<Option<String>>,
    writing: Option<mpsc::Receiver<Result<()>>>,
    /// The storage failure last warned about. Loads retry every two seconds,
    /// so each distinct failure warns once until a load succeeds.
    last_failure: Option<StorageFailure>,
}

pub(super) struct CatalogUpdate {
    pub(super) hosts: Vec<SavedHost>,
    pub(super) wsl: Vec<WslHost>,
    /// The endpoint ID the stored selection names, read only at startup.
    selection: Option<Option<String>>,
    /// The GUI's saved cloud devices, or `None` when that list could not be read.
    #[cfg(feature = "cloud")]
    pub(super) cloud: Option<Vec<crate::cloud::SavedDevice>>,
}

impl CatalogUpdate {
    /// Whether `id` is an endpoint this catalog offers and the user may select.
    fn offers(&self, id: &str) -> bool {
        if let Some(profile) = id.strip_prefix(SAVED_PREFIX) {
            return self
                .hosts
                .iter()
                .any(|host| host.enabled && host.id == profile);
        }
        id.strip_prefix(WSL_PREFIX)
            .is_some_and(|distro| self.wsl.iter().any(|host| host.distro == distro))
    }
}

/// Load both catalogs. A WSL distribution chosen last wins over upstream's
/// selection, which cannot name one and so says Local whenever it was chosen.
/// The GUI's saved cloud devices; `None` when they cannot be read, so the
/// current cloud endpoints are kept rather than dropped.
#[cfg(feature = "cloud")]
fn cloud_devices() -> Option<Vec<crate::cloud::SavedDevice>> {
    // Devices saved on another system stay in the file but are not offered.
    if crate::cloud::unavailable().is_some() {
        return Some(Vec::new());
    }
    crate::cloud::load()
        .inspect_err(|error| {
            tracing::warn!(category = "cloud_catalog", %error, "Cannot read saved cloud devices");
        })
        .ok()
}

fn load(development: bool, startup: bool) -> Result<CatalogUpdate> {
    // Only Windows has distributions; elsewhere the file is never read.
    let wsl = if cfg!(windows) {
        herdr_client::load_wsl_hosts(development)?
    } else {
        Default::default()
    };
    if !startup {
        return Ok(CatalogUpdate {
            hosts: herdr_client::load_saved_hosts(development)?,
            wsl: wsl.hosts,
            selection: None,
            #[cfg(feature = "cloud")]
            cloud: cloud_devices(),
        });
    }
    let (hosts, selected) = herdr_client::load_saved_host_selection(development)?;
    let selection = match wsl.selected_host() {
        Some(host) => Some(format!("{WSL_PREFIX}{}", host.distro)),
        None => selected.map(|id| format!("{SAVED_PREFIX}{id}")),
    };
    Ok(CatalogUpdate {
        hosts,
        wsl: wsl.hosts,
        selection: Some(selection),
        #[cfg(feature = "cloud")]
        cloud: cloud_devices(),
    })
}

/// Persist the choice of `selected`, an endpoint ID or `None` for Local, to
/// whichever store can name it, clearing the other.
fn store(development: bool, selected: Option<&str>) -> Result<()> {
    let profile = selected.and_then(|id| id.strip_prefix(SAVED_PREFIX));
    let distro = selected.and_then(|id| id.strip_prefix(WSL_PREFIX));
    herdr_client::store_saved_host_selection(development, profile)?;
    herdr_client::store_wsl_selection(development, distro)?;
    Ok(())
}

impl Catalog {
    pub fn new(target: &ConnectTarget) -> Self {
        Self {
            development: match target {
                ConnectTarget::Socket(_) => None,
                ConnectTarget::Session { development, .. } => Some(*development),
                _ => Some(false),
            },
            pending: None,
            next_poll: Instant::now(),
            desired: None,
            initialized: false,
            restore_pending: false,
            queued_write: None,
            writing: None,
            last_failure: None,
        }
    }

    pub(super) fn poll(&mut self) -> Option<Result<CatalogUpdate>> {
        let development = self.development?;
        if let Some(result) = self.pending.as_ref().and_then(|rx| rx.try_recv().ok()) {
            self.pending = None;
            self.next_poll = Instant::now() + Duration::from_secs(2);
            if let Some(failure) = self.new_failure(&result) {
                failure.warn("Host catalog");
            }
            return Some(result);
        }
        if self.pending.is_none() && Instant::now() >= self.next_poll {
            let (tx, rx) = mpsc::sync_channel(1);
            self.pending = Some(rx);
            let startup = !self.initialized;
            if let Err(error) = std::thread::Builder::new()
                .name("herdr-gui-catalog".into())
                .spawn(move || {
                    let _ = tx.send(load(development, startup));
                })
            {
                self.pending = None;
                self.next_poll = Instant::now() + Duration::from_secs(2);
                return Some(Err(error.into()));
            }
        }
        None
    }

    /// The storage failure behind `result` when it differs from the last one.
    fn new_failure(&mut self, result: &Result<CatalogUpdate>) -> Option<StorageFailure> {
        let failure = result
            .as_ref()
            .err()
            .and_then(|error| StorageFailure::find(error));
        if failure == self.last_failure {
            return None;
        }
        self.last_failure = failure.clone();
        failure
    }

    pub(super) fn accept(&mut self, update: &CatalogUpdate) {
        if !self.initialized {
            self.desired = update.selection.clone().flatten();
            self.restore_pending = self.desired.is_some();
            self.initialized = true;
        }
        if self.desired.as_ref().is_some_and(|id| !update.offers(id)) {
            self.desired = None;
            self.restore_pending = false;
        }
    }

    pub(super) fn choose(&mut self, id: &str) {
        // Also cancels an in-flight startup restore when Local is clicked.
        self.initialized = true;
        self.restore_pending = false;
        self.desired = (id != LOCAL).then(|| id.to_owned());
        if self.development.is_some() {
            self.queued_write = Some(self.desired.clone());
        }
    }

    pub(super) fn poll_write(&mut self) -> Option<Error> {
        let development = self.development?;
        let mut error = None;
        if let Some(result) = self.writing.as_ref().and_then(|rx| rx.try_recv().ok()) {
            self.writing = None;
            error = result.err();
        }
        // Serialize this client's writes so rapid choices cannot finish backwards.
        if self.writing.is_none()
            && let Some(selected) = self.queued_write.take()
        {
            let (tx, rx) = mpsc::sync_channel(1);
            match std::thread::Builder::new()
                .name("herdr-gui-selection".into())
                .spawn(move || {
                    let _ = tx.send(store(development, selected.as_deref()));
                }) {
                Ok(_) => self.writing = Some(rx),
                Err(e) => error = Some(e.into()),
            }
        }
        error
    }
}

impl HerdrWindow {
    pub(super) fn restore_selection(&mut self, cx: &mut Context<Self>) {
        if !self.catalog.restore_pending {
            return;
        }
        let Some(id) = self.catalog.desired.clone() else {
            return;
        };
        if self.endpoints.iter().any(|endpoint| {
            endpoint.id == id
                && endpoint.enabled
                && endpoint.connection.handle.is_some()
                && endpoint.live.status.is_connected()
                && endpoint.live.snapshot.is_some()
        }) {
            // One handoff attempt: activation failure may fall back to Local,
            // but must neither overwrite the preference nor loop on every tick.
            self.catalog.restore_pending = false;
            self.switch_endpoint(&id, cx);
        }
    }

    /// SSH hosts and WSL distributions only, keeping the current cloud
    /// endpoints; for fixtures.
    #[cfg(test)]
    pub(crate) fn reconcile_catalog(
        &mut self,
        hosts: Vec<SavedHost>,
        wsl: Vec<WslHost>,
        cx: &mut Context<Self>,
    ) {
        #[cfg(feature = "cloud")]
        self.reconcile_devices(hosts, wsl, None, cx);
        #[cfg(not(feature = "cloud"))]
        self.reconcile_devices(hosts, wsl, cx);
    }

    /// Replace the remote endpoints with every saved device. `None` keeps the
    /// current cloud endpoints, so a failed read of the GUI's own list never
    /// drops their connections.
    pub(super) fn reconcile_devices(
        &mut self,
        hosts: Vec<SavedHost>,
        wsl: Vec<WslHost>,
        #[cfg(feature = "cloud")] cloud: Option<Vec<crate::cloud::SavedDevice>>,
        cx: &mut Context<Self>,
    ) {
        #[cfg_attr(not(feature = "cloud"), allow(unused_mut))]
        let mut devices = devices(hosts, wsl);
        #[cfg(feature = "cloud")]
        match cloud {
            Some(cloud) => devices.extend(cloud.into_iter().map(|saved| Device {
                id: saved.endpoint_id(),
                target: saved.target(),
                label: saved.label,
                enabled: saved.enabled,
            })),
            None => devices.extend(
                self.endpoints
                    .iter()
                    .filter(|endpoint| {
                        matches!(endpoint.connection.target, ConnectTarget::Cloud { .. })
                    })
                    .map(|endpoint| Device {
                        id: endpoint.id.clone(),
                        label: endpoint.label.clone(),
                        target: endpoint
                            .saved
                            .clone()
                            .unwrap_or_else(|| endpoint.connection.target.clone()),
                        enabled: endpoint.enabled,
                    }),
            ),
        }
        let selected = &self.endpoints[self.selected_endpoint];
        let selected_id = selected.id.clone();
        let selected_retired = self.selected_endpoint != 0
            && !devices.iter().any(|device| {
                device.id == selected_id
                    && device.enabled
                    && !entry_changed(selected, &device.target)
            });
        if selected_retired {
            self.switch_endpoint(LOCAL, cx);
        }
        let selected_id = self.endpoints[self.selected_endpoint].id.clone();
        let mut previous = std::mem::take(&mut self.endpoints);
        let mut next = vec![previous.remove(0)];
        for device in devices {
            let mut endpoint = if let Some(index) = previous.iter().position(|e| e.id == device.id)
            {
                previous.remove(index)
            } else {
                Endpoint::new(
                    device.id,
                    device.label.clone(),
                    device.target.clone(),
                    device.enabled,
                )
            };
            let changed =
                endpoint.enabled != device.enabled || entry_changed(&endpoint, &device.target);
            if changed {
                endpoint.stop();
                endpoint.attempts = 0;
                endpoint.connection.target = device.target.clone();
                endpoint.enabled = device.enabled;
                endpoint.detached = false;
                endpoint.retry_at = Instant::now();
            }
            endpoint.label = device.label;
            endpoint.saved = Some(device.target);
            next.push(endpoint);
        }
        self.endpoints = next;
        self.selected_endpoint = self
            .endpoints
            .iter()
            .position(|e| e.id == selected_id)
            .unwrap_or(0);
        cx.notify();
    }
}

/// One saved device as its catalog describes it.
struct Device {
    id: String,
    label: String,
    target: ConnectTarget,
    enabled: bool,
}

/// Every saved device in sidebar order: SSH hosts as upstream lists them, then
/// WSL distributions in the order they were added. A distribution has no
/// disabled state; removing it is how it stops being dialled.
fn devices(hosts: Vec<SavedHost>, wsl: Vec<WslHost>) -> Vec<Device> {
    let ssh = hosts.into_iter().map(|host| Device {
        id: format!("{SAVED_PREFIX}{}", host.id),
        label: host.label,
        target: ConnectTarget::Ssh {
            target: host.target,
            session: host.session,
        },
        enabled: host.enabled,
    });
    let wsl = wsl.into_iter().map(|host| Device {
        id: format!("{WSL_PREFIX}{}", host.distro),
        label: host.distro.clone(),
        target: ConnectTarget::Wsl {
            distro: host.distro,
            session: host.session,
        },
        enabled: true,
    });
    ssh.chain(wsl).collect()
}

/// Whether a saved entry differs from the one this endpoint was last reconciled
/// against, which is what an edit to a device's saved profile looks like. An
/// endpoint that has never been reconciled compares its live target instead, so
/// one built outside the catalog still retires when its entry changes. The
/// sessions list deliberately points an endpoint at other sessions of the same
/// device, so the live target alone is not the device's identity.
fn entry_changed(endpoint: &Endpoint, saved: &ConnectTarget) -> bool {
    endpoint
        .saved
        .as_ref()
        .unwrap_or(&endpoint.connection.target)
        != saved
}

#[cfg(test)]
mod tests;
