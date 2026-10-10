//! Upstream client/endpoint/catalog.rs schema and config/io.rs paths.
use crate::{Error, Result, StorageOperation, session_socket};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedHost {
    pub id: String,
    pub label: String,
    pub target: String,
    pub session: String,
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u32,
    #[serde(default)]
    selected_profile: Option<String>,
    #[serde(default)]
    ssh: Vec<SavedHost>,
}

/// Load profiles only, like upstream `load_profiles`; selection is client-local.
/// This performs bounded filesystem I/O; call it from a background task.
pub fn load_saved_hosts(development: bool) -> Result<Vec<SavedHost>> {
    load_path(&catalog_path(development, |name| env::var_os(name)))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    version: u32,
    selected_profile: Option<String>,
}

/// Load the startup catalog and desired profile (None means Local). Missing,
/// malformed or stale selection files retain the catalog's legacy selection.
/// Live clients should subsequently use `load_saved_hosts`, not reload selection.
pub fn load_saved_host_selection(development: bool) -> Result<(Vec<SavedHost>, Option<String>)> {
    load_with_selection(&catalog_path(development, |name| env::var_os(name)))
}

fn load_with_selection(path: &Path) -> Result<(Vec<SavedHost>, Option<String>)> {
    let catalog = load_catalog(path)?;
    let mut selected = catalog.selected_profile;
    // Selection errors must never discard an otherwise valid catalog.
    if let Ok(Some(selection)) = read_selection(&path.with_file_name("endpoint-selection.json"))
        && selection.selected_profile.as_ref().is_none_or(|id| {
            catalog
                .ssh
                .iter()
                .any(|host| host.enabled && &host.id == id)
        })
    {
        selected = selection.selected_profile;
    }
    Ok((catalog.ssh, selected))
}

fn read_selection(path: &Path) -> Result<Option<Selection>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::storage(StorageOperation::Open, path, error)),
    };
    if !file
        .metadata()
        .map_err(|error| Error::storage(StorageOperation::Metadata, path, error))?
        .is_file()
    {
        return Err(Error::storage(
            StorageOperation::Validate,
            path,
            Error::SelectionNotFile,
        ));
    }
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|error| Error::storage(StorageOperation::Read, path, error))?;
    if bytes.len() > 65536 {
        return Err(Error::storage(
            StorageOperation::Validate,
            path,
            Error::SelectionLimit,
        ));
    }
    let selection: Selection = serde_json::from_slice(&bytes).map_err(|error| {
        Error::storage(
            StorageOperation::Decode,
            path,
            Error::SelectionSchema(error),
        )
    })?;
    if selection.version != 1 {
        return Err(Error::storage(
            StorageOperation::Validate,
            path,
            Error::SelectionVersion,
        ));
    }
    Ok(Some(selection))
}

/// Persist an explicit choice without rewriting profiles. Validates against the
/// current catalog, atomically replaces a private file, and syncs its directory.
/// All selection APIs perform filesystem I/O and belong on a background worker.
pub fn store_saved_host_selection(development: bool, selected: Option<&str>) -> Result<()> {
    store_selection(
        &catalog_path(development, |name| env::var_os(name)),
        selected,
    )
}

fn store_selection(catalog: &Path, selected: Option<&str>) -> Result<()> {
    let hosts = load_path(catalog)?;
    if selected.is_some_and(|id| !hosts.iter().any(|host| host.enabled && host.id == id)) {
        return Err(Error::storage(
            StorageOperation::Validate,
            catalog,
            Error::SelectionUnavailable,
        ));
    }
    let path = catalog.with_file_name("endpoint-selection.json");
    let content = serde_json::to_vec_pretty(&Selection {
        version: 1,
        selected_profile: selected.map(str::to_owned),
    })
    .map_err(|error| {
        Error::storage(
            StorageOperation::Encode,
            &path,
            Error::SelectionSchema(error),
        )
    })?;
    write_private(&path, &content)
}

/// Atomically replace `path` with `content` in a private file, syncing its
/// directory. Refuses to replace anything but a regular file. Blocking.
pub(crate) fn write_private(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::storage(StorageOperation::Validate, path, Error::StoragePath))?;
    fs::create_dir_all(parent)
        .map_err(|error| Error::storage(StorageOperation::CreateDirectory, parent, error))?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(Error::storage(
                StorageOperation::Validate,
                path,
                Error::StorageDestinationNotFile,
            ));
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            return Err(Error::storage(StorageOperation::Metadata, path, error));
        }
        _ => {}
    }
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
    let temp = parent.join(format!(
        ".endpoints-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    // Windows has no mode bits; the file inherits the private state directory's ACL.
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temp)
        .map_err(|error| Error::storage(StorageOperation::Create, &temp, error))?;
    let result = (|| {
        file.write_all(content)
            .map_err(|error| Error::storage(StorageOperation::Write, &temp, error))?;
        file.sync_all()
            .map_err(|error| Error::storage(StorageOperation::Sync, &temp, error))?;
        drop(file);
        fs::rename(&temp, path).map_err(|error| {
            Error::storage(
                StorageOperation::Replace {
                    destination: path.to_owned(),
                },
                &temp,
                error,
            )
        })?;
        // A directory handle cannot be opened for fsync on Windows, where the
        // replacement is already ordered by the filesystem.
        #[cfg(unix)]
        File::open(parent)
            .map_err(|error| Error::storage(StorageOperation::Open, parent, error))?
            .sync_all()
            .map_err(|error| Error::storage(StorageOperation::Sync, parent, error))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

/// Upstream's state root for the endpoint catalog. Windows has no XDG layout by
/// default, so upstream falls back to `%LOCALAPPDATA%` there; the catalog is
/// shared with the daemon, so both must agree on where it lives.
pub(crate) fn catalog_path(development: bool, var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    let app = if development { "herdr-dev" } else { "herdr" };
    let root = (|| {
        if let Some(dir) = var("XDG_STATE_HOME") {
            return Some(PathBuf::from(dir));
        }
        #[cfg(windows)]
        {
            if let Some(dir) = var("LOCALAPPDATA") {
                return Some(PathBuf::from(dir));
            }
            if let Some(profile) = var("USERPROFILE") {
                return Some(PathBuf::from(profile).join("AppData").join("Local"));
            }
        }
        var("HOME").map(|home| PathBuf::from(home).join(".local/state"))
    })();
    root.map(|base| base.join(app))
        .unwrap_or_else(|| env::temp_dir().join(format!("{app}-state")))
        .join("client/endpoints.json")
}

fn load_path(path: &Path) -> Result<Vec<SavedHost>> {
    load_catalog(path).map(|catalog| catalog.ssh)
}

fn load_catalog(path: &Path) -> Result<Catalog> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(Catalog {
                version: 1,
                selected_profile: None,
                ssh: Vec::new(),
            });
        }
        Err(e) => return Err(Error::storage(StorageOperation::Open, path, e)),
    };
    if !file
        .metadata()
        .map_err(|error| Error::storage(StorageOperation::Metadata, path, error))?
        .is_file()
    {
        return Err(Error::storage(
            StorageOperation::Validate,
            path,
            Error::CatalogNotFile,
        ));
    }
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|error| Error::storage(StorageOperation::Read, path, error))?;
    parse_catalog(&bytes).map_err(|error| Error::storage(StorageOperation::Decode, path, error))
}

#[cfg(test)]
fn parse(bytes: &[u8]) -> Result<Vec<SavedHost>> {
    parse_catalog(bytes).map(|catalog| catalog.ssh)
}

fn parse_catalog(bytes: &[u8]) -> Result<Catalog> {
    if bytes.len() > 65536 {
        return Err(Error::CatalogLimit);
    }
    // Do not include serde's error text: unknown field names can contain secrets.
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(Error::CatalogSchema)?;
    if catalog.version != 1 || catalog.ssh.len() > 64 {
        return Err(Error::CatalogVersionOrCount);
    }
    let mut ids = HashSet::new();
    for host in &catalog.ssh {
        if !valid_profile_id(&host.id) || !ids.insert(&host.id) {
            return Err(Error::ProfileId);
        }
        let label = host.label.trim();
        if label.is_empty() || label.len() > 128 || label.chars().any(char::is_control) {
            return Err(Error::ProfileLabel);
        }
        validate_target(&host.target)?;
        session_socket(Path::new(""), &host.session)?;
    }
    if catalog
        .selected_profile
        .as_ref()
        .is_some_and(|id| !catalog.ssh.iter().any(|h| &h.id == id && h.enabled))
    {
        return Err(Error::SelectionUnavailable);
    }
    Ok(catalog)
}

/// Upstream profile IDs are 32 lowercase hex digits, so they are also safe
/// in file names and command arguments.
pub fn valid_profile_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn validate_target(target: &str) -> Result<()> {
    let authority = target.strip_prefix("ssh://").unwrap_or(target);
    if target.is_empty()
        || target.starts_with('-')
        || target.len() > 1024
        || target.chars().any(char::is_control)
        || authority
            .rsplit_once('@')
            .is_some_and(|(user, _)| user.contains(':'))
    {
        return Err(Error::InvalidSshTarget);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
