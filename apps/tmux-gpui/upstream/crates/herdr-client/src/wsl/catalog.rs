//! The WSL distributions this client was asked to attach to, and which one it
//! last selected. Upstream's endpoint catalog and selection refuse unknown
//! fields and profile IDs, so these live in a file of their own beside them,
//! which upstream never reads.
use super::valid_distro;
use crate::{
    Error, Result, StorageOperation,
    catalog::{catalog_path, write_private},
    session_socket,
};
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};

/// One device per distribution, like one saved profile per SSH host entry.
const MAX_HOSTS: usize = 64;
const MAX_BYTES: u64 = 64 * 1024;
const FILE_NAME: &str = "gpui-wsl.json";

/// Serializes this process's read-modify-write cycles on the file.
static WRITES: Mutex<()> = Mutex::new(());

/// A WSL distribution saved as a device, and the session it attaches to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WslHost {
    pub distro: String,
    pub session: String,
}

/// The saved distributions, in the order they were added, and the one this
/// client last selected, if a distribution was its last choice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WslHosts {
    #[serde(default = "version")]
    version: u32,
    #[serde(default)]
    pub selected: Option<String>,
    #[serde(default)]
    pub hosts: Vec<WslHost>,
}

fn version() -> u32 {
    1
}

impl Default for WslHosts {
    fn default() -> Self {
        Self {
            version: version(),
            selected: None,
            hosts: Vec::new(),
        }
    }
}

impl WslHosts {
    fn validate(&self) -> Result<()> {
        if self.version != 1 || self.hosts.len() > MAX_HOSTS {
            return Err(Error::WslCatalog);
        }
        for (index, host) in self.hosts.iter().enumerate() {
            if !valid_distro(&host.distro)
                || session_socket(Path::new(""), &host.session).is_err()
                || self.hosts[..index]
                    .iter()
                    .any(|other| other.distro == host.distro)
            {
                return Err(Error::WslCatalog);
            }
        }
        Ok(())
    }

    /// The selection, when it still names a saved distribution.
    pub fn selected_host(&self) -> Option<&WslHost> {
        let selected = self.selected.as_deref()?;
        self.hosts.iter().find(|host| host.distro == selected)
    }
}

fn path(development: bool) -> PathBuf {
    catalog_path(development, |name| env::var_os(name)).with_file_name(FILE_NAME)
}

/// The saved distributions. A missing file is an empty list. Blocking: call
/// it from a background thread.
pub fn load_wsl_hosts(development: bool) -> Result<WslHosts> {
    read(&path(development))
}

/// Save `distro` as a device attached to `session`. A distribution is saved
/// once; pick another of its sessions from the sessions list instead.
pub fn add_wsl_host(development: bool, distro: &str, session: &str) -> Result<()> {
    add(&path(development), distro, session)
}

fn add(path: &Path, distro: &str, session: &str) -> Result<()> {
    super::validate(distro, session)?;
    update(path, |hosts| {
        if hosts.hosts.iter().any(|host| host.distro == distro) {
            return Err(Error::WslHostExists);
        }
        hosts.hosts.push(WslHost {
            distro: distro.to_owned(),
            session: session.to_owned(),
        });
        Ok(())
    })
}

/// Forget a saved distribution, and the selection if it named it. Nothing
/// inside the distribution is touched.
pub fn remove_wsl_host(development: bool, distro: &str) -> Result<()> {
    remove(&path(development), distro)
}

fn remove(path: &Path, distro: &str) -> Result<()> {
    update(path, |hosts| {
        let before = hosts.hosts.len();
        hosts.hosts.retain(|host| host.distro != distro);
        if hosts.hosts.len() == before {
            return Err(Error::WslHostMissing);
        }
        if hosts.selected.as_deref() == Some(distro) {
            hosts.selected = None;
        }
        Ok(())
    })
}

/// Remember which distribution, if any, this client last selected.
pub fn store_wsl_selection(development: bool, selected: Option<&str>) -> Result<()> {
    select(&path(development), selected)
}

fn select(path: &Path, selected: Option<&str>) -> Result<()> {
    update(path, |hosts| {
        if selected.is_some_and(|distro| !hosts.hosts.iter().any(|host| host.distro == distro)) {
            return Err(Error::WslHostMissing);
        }
        hosts.selected = selected.map(str::to_owned);
        Ok(())
    })
}

fn update(path: &Path, change: impl FnOnce(&mut WslHosts) -> Result<()>) -> Result<()> {
    let _guard = WRITES.lock().unwrap_or_else(|error| error.into_inner());
    let mut hosts = read(path)?;
    let before = hosts.clone();
    change(&mut hosts)?;
    if hosts == before {
        return Ok(());
    }
    let content = serde_json::to_vec_pretty(&hosts).map_err(|error| {
        Error::storage(
            StorageOperation::Encode,
            path,
            Error::WslCatalogSchema(error),
        )
    })?;
    write_private(path, &content)
}

fn read(path: &Path) -> Result<WslHosts> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(WslHosts::default()),
        Err(error) => return Err(Error::storage(StorageOperation::Open, path, error)),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| Error::storage(StorageOperation::Read, path, error))?;
    parse(&bytes).map_err(|error| Error::storage(StorageOperation::Decode, path, error))
}

fn parse(bytes: &[u8]) -> Result<WslHosts> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Error::WslCatalog);
    }
    let hosts: WslHosts = serde_json::from_slice(bytes).map_err(Error::WslCatalogSchema)?;
    hosts.validate()?;
    Ok(hosts)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
