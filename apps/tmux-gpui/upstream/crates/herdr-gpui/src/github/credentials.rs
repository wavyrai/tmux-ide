//! Opt-in Unix plaintext storage. All callers run on a background worker.
#![forbid(unsafe_code)]

use super::Result;
use crate::Error;
use secrecy::SecretString;
use std::{ffi::CStr, path::Path};

#[cfg(unix)]
use super::token::{Credential, LIMIT};
#[cfg(unix)]
use rustix::fs::{AtFlags, Mode, OFlags, open, openat, renameat, unlinkat};
#[cfg(unix)]
use rustix::process::geteuid;
#[cfg(unix)]
use secrecy::ExposeSecret;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use std::{
    fs::File,
    io::{Read, Write},
};
#[cfg(unix)]
use zeroize::Zeroizing;

/// Keeping a token private on disk here depends on `openat`, POSIX ownership,
/// and mode bits. Off POSIX there is no equivalent this crate can rely on, so
/// `Store::File` is never selected and only removal, which has nothing to
/// remove, succeeds.
#[cfg(not(unix))]
pub(super) fn read(_path: &Path, _name: &CStr) -> Result<Option<SecretString>> {
    Ok(None)
}

#[cfg(all(not(unix), feature = "cloud"))]
pub(super) fn read_checked(
    _path: &Path,
    _name: &CStr,
    _validate: fn(&SecretString) -> Result<()>,
) -> Result<Option<SecretString>> {
    Ok(None)
}

#[cfg(all(not(unix), feature = "cloud"))]
pub(super) fn store_checked(
    path: &Path,
    name: &CStr,
    token: Option<&SecretString>,
    plaintext: bool,
    _validate: fn(&SecretString) -> Result<()>,
) -> Result<()> {
    store(path, name, token, plaintext)
}

#[cfg(not(unix))]
pub(super) fn store(
    _path: &Path,
    _name: &CStr,
    token: Option<&SecretString>,
    _plaintext: bool,
) -> Result<()> {
    if token.is_some() {
        return Err(Error::CredentialUnsupported);
    }
    Ok(())
}

#[cfg(unix)]
fn directory(path: &Path) -> Result<File> {
    let dir = File::from(
        open(
            path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| Error::CredentialIo(error.into()))?,
    );
    let metadata = dir.metadata().map_err(Error::CredentialIo)?;
    if metadata.uid() != geteuid().as_raw() || metadata.mode() & 0o022 != 0 {
        return Err(Error::CredentialPermissions);
    }
    Ok(dir)
}

#[cfg(unix)]
fn existing(dir: &File, name: &CStr) -> Result<Option<File>> {
    // Keep access relative to the validated directory, even if its path is replaced.
    let file = match openat(
        dir,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => File::from(fd),
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(Error::CredentialIo(error.into())),
    };
    let metadata = file.metadata().map_err(Error::CredentialIo)?;
    if !metadata.is_file()
        || metadata.uid() != geteuid().as_raw()
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
        || metadata.len() > LIMIT as u64
    {
        return Err(Error::CredentialPermissions);
    }
    Ok(Some(file))
}

#[cfg(unix)]
pub(super) fn read(path: &Path, name: &CStr) -> Result<Option<SecretString>> {
    read_checked(path, name, github_record)
}

#[cfg(unix)]
fn github_record(value: &SecretString) -> Result<()> {
    Credential::decode(value).map(drop)
}

/// `read` for a record another feature owns; `validate` must bound its size.
#[cfg(unix)]
pub(super) fn read_checked(
    path: &Path,
    name: &CStr,
    validate: fn(&SecretString) -> Result<()>,
) -> Result<Option<SecretString>> {
    let dir = directory(path)?;
    let Some(file) = existing(&dir, name)? else {
        return Ok(None);
    };
    let mut bytes = Zeroizing::new(Vec::with_capacity(LIMIT + 1));
    file.take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(Error::CredentialIo)?;
    let text = std::str::from_utf8(&bytes).map_err(Error::GitHubEncoding)?;
    let value = SecretString::from(text);
    validate(&value)?;
    Ok(Some(value))
}

#[cfg(unix)]
pub(super) fn store(
    path: &Path,
    name: &CStr,
    token: Option<&SecretString>,
    plaintext: bool,
) -> Result<()> {
    if token.is_some() && !plaintext {
        return Err(Error::CredentialPolicy);
    }
    // Explicit removal is allowed even after opting out of plaintext storage.
    write(path, name, token)
}

/// `store` for a record another feature owns; `validate` must bound its size.
#[cfg(all(unix, any(test, feature = "cloud")))]
pub(super) fn store_checked(
    path: &Path,
    name: &CStr,
    token: Option<&SecretString>,
    plaintext: bool,
    validate: fn(&SecretString) -> Result<()>,
) -> Result<()> {
    if token.is_some() && !plaintext {
        return Err(Error::CredentialPolicy);
    }
    write_checked(path, name, token, validate)
}

#[cfg(unix)]
fn write(path: &Path, target: &CStr, token: Option<&SecretString>) -> Result<()> {
    write_checked(path, target, token, github_record)
}

#[cfg(unix)]
fn write_checked(
    path: &Path,
    target: &CStr,
    token: Option<&SecretString>,
    validate: fn(&SecretString) -> Result<()>,
) -> Result<()> {
    let dir = directory(path)?;
    let present = existing(&dir, target)?.is_some();
    let Some(token) = token else {
        if present {
            unlinkat(&dir, target, AtFlags::empty())
                .map_err(|error| Error::CredentialIo(error.into()))?;
        }
        return dir.sync_all().map_err(Error::CredentialIo);
    };
    validate(token)?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = format!(
        ".github-credentials-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let mut file = File::from(
        openat(
            &dir,
            name.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|error| Error::CredentialIo(error.into()))?,
    );
    let result = (|| {
        file.write_all(token.expose_secret().as_bytes())
            .map_err(Error::CredentialIo)?;
        file.sync_all().map_err(Error::CredentialIo)?;
        existing(&dir, target)?;
        // Replace the directory entry atomically, never a symlink's target.
        renameat(&dir, name.as_str(), &dir, target)
            .map_err(|error| Error::CredentialIo(error.into()))?;
        dir.sync_all().map_err(Error::CredentialIo)
    })();
    let _ = unlinkat(&dir, name.as_str(), AtFlags::empty());
    result
}

#[cfg(all(test, unix))]
mod tests;
