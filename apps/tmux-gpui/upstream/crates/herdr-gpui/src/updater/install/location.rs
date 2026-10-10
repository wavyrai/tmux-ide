//! Where this installation lives and whether it may be replaced: an owned,
//! symlink-free location outside any package manager, and the lock files that
//! keep two updaters off it at once.
use super::{Installation, Mode, io, output, signing::identity};
use crate::updater::{
    error::{Result, UpdateError as Error},
    release,
};
use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
};

pub(super) fn owned(path: &Path, uid: u32, directory: bool) -> Result<fs::Metadata> {
    let meta = fs::symlink_metadata(path).map_err(io)?;
    if meta.file_type().is_symlink()
        || meta.is_dir() != directory
        || (!directory && !meta.is_file())
        || meta.uid() != uid
        || meta.mode() & 0o6022 != 0
        || meta.permissions().readonly()
    {
        return Err(Error::UnsafeInstallation(path.to_owned()));
    }
    Ok(meta)
}

pub(super) fn no_links(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::RelativeInstallation);
    }
    let mut prefix = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) {
            return Err(Error::NoncanonicalInstallation);
        }
        prefix.push(part);
        if fs::symlink_metadata(&prefix)
            .map_err(io)?
            .file_type()
            .is_symlink()
        {
            return Err(Error::SymlinkedInstallation);
        }
    }
    Ok(())
}

pub(super) fn trusted_mac_parent(owner: u32, mode: u32, uid: u32) -> bool {
    (owner == uid || owner == 0) && mode & 0o6002 == 0
}

pub(super) fn installation_parent(path: &Path, mode: Mode, uid: u32) -> Result<()> {
    no_links(path)?;
    if mode == Mode::Linux {
        owned(path, uid, true)?;
    } else {
        let meta = fs::symlink_metadata(path).map_err(io)?;
        if !meta.is_dir() || !trusted_mac_parent(meta.uid(), meta.mode(), uid) {
            return Err(Error::UnsafeMacParent);
        }
        // /Applications is normally root:admin 0775. Do not equate ownership
        // with access: creating our private stage must succeed without elevation.
    }
    Ok(())
}

/// Distribution packages install under `/usr` (never `/usr/local`, which is
/// the administrator's), and Nix into its read-only store. Neither may be
/// overwritten, and naming the owner is clearer than "outside HOME".
pub(super) fn system_managed(executable: &Path) -> bool {
    (executable.starts_with("/usr") && !executable.starts_with("/usr/local"))
        || executable.starts_with("/nix/store")
}

pub(super) fn linux_location(
    executable: &Path,
    home: &Path,
    uid: u32,
    packaged: bool,
) -> Result<()> {
    if packaged || system_managed(executable) {
        return Err(Error::PackageManaged);
    }
    no_links(executable)?;
    owned(home, uid, true)?;
    if !executable.starts_with(home) {
        return Err(Error::OutsideHome);
    }
    for ancestor in executable
        .parent()
        .ok_or(Error::MissingExecutableParent)?
        .ancestors()
        .take_while(|p| p.starts_with(home))
    {
        owned(ancestor, uid, true)?;
    }
    let metadata = owned(executable, uid, false)?;
    if metadata.mode() & 0o111 == 0 || metadata.nlink() != 1 {
        return Err(Error::NotStandalone);
    }
    Ok(())
}

/// The effective UID of this process, as the system reports it.
pub(in crate::updater) fn effective_uid() -> Result<u32> {
    uid(&AtomicBool::new(false))
}

fn uid(cancel: &AtomicBool) -> Result<u32> {
    output(Command::new("/usr/bin/id").arg("-u"), cancel)?
        .trim()
        .parse()
        .map_err(Error::EffectiveUid)
}

/// The bundle root of a running macOS installation. Defined once: brew
/// delegation and standalone installation must agree on what "this app" is.
pub(in crate::updater) fn mac_bundle(executable: &Path) -> Result<PathBuf> {
    let root = executable.ancestors().nth(3).ok_or(Error::NotHerdrBundle)?;
    if root.file_name() != Some("Herdr.app".as_ref())
        || executable != root.join("Contents/MacOS/Herdr")
    {
        return Err(Error::NotHerdrBundle);
    }
    Ok(root.to_owned())
}

pub(super) fn detect(cancel: &AtomicBool) -> Result<Installation> {
    if release::parse_version(crate::APP_VERSION).is_none()
        || option_env!("HERDR_UPDATE_PUBLIC_KEY").is_none()
    {
        return Err(Error::LocalBuild);
    }
    let uid = uid(cancel)?;
    if uid == 0 {
        return Err(Error::RootUser);
    }
    // Linux current_exe identifies the loaded executable, not a symlink launcher.
    // Eligibility applies to that resolved origin and its ancestors under HOME.
    let executable = env::current_exe().map_err(io)?;
    no_links(&executable)?;
    let mode = if cfg!(target_os = "macos") {
        Mode::Mac
    } else if cfg!(target_os = "linux") {
        Mode::Linux
    } else {
        return Err(Error::UnsupportedPlatform);
    };
    let destination = match mode {
        Mode::Mac => mac_bundle(&executable)?,
        Mode::Linux => {
            let packaged = ["APPIMAGE", "SNAP", "FLATPAK_ID"]
                .iter()
                .any(|key| env::var_os(key).is_some());
            let home =
                fs::canonicalize(env::var_os("HOME").ok_or(Error::MissingHome)?).map_err(io)?;
            linux_location(&executable, &home, uid, packaged)?;
            executable.clone()
        }
    };
    owned(&destination, uid, mode == Mode::Mac)?;
    installation_parent(
        destination
            .parent()
            .ok_or(Error::MissingInstallationParent)?,
        mode,
        uid,
    )?;
    if mode == Mode::Mac {
        for ancestor in executable
            .parent()
            .ok_or(Error::MissingExecutableParent)?
            .ancestors()
            .take_while(|path| path.starts_with(&destination))
        {
            owned(ancestor, uid, true)?;
        }
    }
    if owned(&executable, uid, false)?.mode() & 0o111 == 0 {
        return Err(Error::NotExecutable);
    }
    if mode == Mode::Mac {
        identity(&destination, crate::APP_VERSION, cancel)?;
    }
    Ok(Installation {
        mode,
        destination,
        executable,
        uid,
    })
}

pub(super) fn lock(installation: &Installation) -> Result<File> {
    let lease = lock_file(installation, ".update-lock")?;
    // A helper holds the handoff lease before READY until replacement finishes.
    // This closes the primary-lock handoff gap without inheriting raw FDs.
    match lock_file(installation, ".update-handoff") {
        Ok(probe) => probe.unlock().map_err(io)?,
        Err(error) => {
            let _ = lease.unlock();
            return Err(error);
        }
    }
    Ok(lease)
}

pub(super) fn lock_file(installation: &Installation, suffix: &str) -> Result<File> {
    installation_parent(
        installation
            .destination
            .parent()
            .ok_or(Error::MissingInstallationParent)?,
        installation.mode,
        installation.uid,
    )?;
    let name = installation
        .destination
        .file_name()
        .ok_or(Error::MissingInstallationName)?;
    let mut lock_name = OsString::from(".");
    lock_name.push(name);
    lock_name.push(suffix);
    let path = installation.destination.with_file_name(lock_name);
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            owned(&path, installation.uid, false)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(io)?
        }
        Err(error) => return Err(io(error)),
    };
    let meta = owned(&path, installation.uid, false)?;
    let opened = file.metadata().map_err(io)?;
    if meta.ino() != opened.ino()
        || meta.dev() != opened.dev()
        || opened.nlink() != 1
        || !opened.is_file()
        || opened.uid() != installation.uid
        || opened.mode() & 0o6022 != 0
    {
        return Err(Error::UnsafeLock);
    }
    file.try_lock().map_err(|error| match error {
        fs::TryLockError::WouldBlock => Error::LockContended,
        fs::TryLockError::Error(source) => Error::Io(source),
    })?;
    Ok(file)
}
