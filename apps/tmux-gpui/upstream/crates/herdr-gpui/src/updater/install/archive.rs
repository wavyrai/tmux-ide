//! Bounded, path-checked extraction of a verified release archive into a
//! private tree. Nothing is written outside the extraction root.
use super::{LIMIT, Mode, check, io};
use crate::updater::error::{Result, UpdateError as Error};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub(super) fn safe_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path.as_os_str().len() <= 4096
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

pub(super) fn safe_link(path: &Path, target: &Path) -> bool {
    if target.as_os_str().is_empty() || target.as_os_str().len() > 4096 {
        return false;
    }
    let mut depth = path.components().count() - 1;
    for part in target.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::CurDir => (),
            Component::ParentDir if depth > 1 => depth -= 1,
            _ => return false,
        }
    }
    depth >= 1
}

pub(super) fn extract(
    archive: &Path,
    root: &Path,
    mode: Mode,
    name: &str,
    cancel: &AtomicBool,
) -> Result<PathBuf> {
    let decoder = flate2::read::MultiGzDecoder::new(File::open(archive).map_err(io)?);
    // Bound even tar headers, padding and extension records, not only file data.
    let mut archive = tar::Archive::new(decoder.take(LIMIT + 1));
    let mut seen = HashSet::new();
    let mut distribution_directories = HashSet::new();
    let mut links = Vec::new();
    let mut expanded = 0u64;
    let mut directories = fs::DirBuilder::new();
    directories.recursive(true).mode(0o700);
    for (index, entry) in archive.entries().map_err(io)?.raw(true).enumerate() {
        check(cancel)?;
        if index >= 20000 {
            return Err(Error::ArchiveEntryLimit);
        }
        let mut entry = entry.map_err(io)?;
        let path = entry.path().map_err(io)?.into_owned();
        if !safe_path(&path) || !seen.insert(path.clone()) {
            return Err(Error::ArchivePath);
        }
        for parent in path
            .ancestors()
            .skip(1)
            .filter(|p| !p.as_os_str().is_empty())
        {
            distribution_directories.insert(parent.to_owned());
        }
        let kind = entry.header().entry_type();
        if mode == Mode::Linux {
            if path != Path::new(name) || !kind.is_file() {
                return Err(Error::LinuxPayload);
            }
        } else if !path.starts_with("Herdr.app") {
            return Err(Error::OutsideBundle);
        }
        expanded = expanded
            .checked_add(entry.size())
            .filter(|size| *size <= LIMIT)
            .ok_or(Error::ExpandedArchiveLimit)?;
        let destination = root.join(&path);
        // Symlinks are created only after every regular write has finished.
        if kind.is_symlink() && mode == Mode::Mac {
            let target = entry
                .link_name()
                .map_err(io)?
                .ok_or(Error::MissingLinkTarget)?
                .into_owned();
            if !safe_link(&path, &target) || entry.size() != 0 {
                return Err(Error::ArchiveSymlink);
            }
            links.push((path, target));
        } else if kind.is_dir() && mode == Mode::Mac {
            if entry.size() != 0 {
                return Err(Error::DirectoryData);
            }
            directories.create(&destination).map_err(io)?;
            distribution_directories.insert(path.clone());
        } else if kind.is_file() {
            directories
                .create(destination.parent().ok_or(Error::MissingArchiveParent)?)
                .map_err(io)?;
            let executable = entry.header().mode().map_err(io)? & 0o111 != 0;
            if mode == Mode::Linux && !executable {
                return Err(Error::PayloadNotExecutable);
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(if executable { 0o700 } else { 0o600 })
                .open(&destination)
                .map_err(io)?;
            let mut buffer = [0; 65536];
            loop {
                check(cancel)?;
                let count = entry.read(&mut buffer).map_err(io)?;
                if count == 0 {
                    break;
                }
                file.write_all(&buffer[..count]).map_err(io)?;
            }
            // Normalize distribution permissions independently of the process
            // umask, without restoring archive write/special bits or changing data.
            file.set_permissions(fs::Permissions::from_mode(if executable {
                0o755
            } else {
                0o644
            }))
            .map_err(io)?;
            file.sync_all().map_err(io)?;
        } else {
            return Err(Error::ArchiveEntryType);
        }
    }
    let mut reader = archive.into_inner();
    let mut buffer = [0; 65536];
    loop {
        check(cancel)?;
        let count = reader.read(&mut buffer).map_err(io)?;
        if count == 0 {
            break;
        }
        if buffer[..count].iter().any(|byte| *byte != 0) {
            return Err(Error::TrailingArchiveData);
        }
    }
    if reader.limit() == 0 {
        return Err(Error::ExpandedArchiveLimit);
    }
    let link_paths: HashSet<&Path> = links.iter().map(|(path, _)| path.as_path()).collect();
    for path in &seen {
        if path
            .ancestors()
            .skip(1)
            .any(|parent| link_paths.contains(parent))
        {
            return Err(Error::ArchiveSymlinkParent);
        }
    }
    // Include implicit parents and empty directories, but never the private
    // extraction root. Do this before creating any symlinks.
    for path in distribution_directories {
        check(cancel)?;
        let path = root.join(path);
        directories.create(&path).map_err(io)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(io)?;
    }
    for (path, target) in &links {
        let destination = root.join(path);
        directories
            .create(destination.parent().ok_or(Error::MissingSymlinkParent)?)
            .map_err(io)?;
        std::os::unix::fs::symlink(target, destination).map_err(io)?;
    }
    // Also reject escape through a chain of individually relative links.
    for (path, _) in links {
        if !fs::canonicalize(root.join(path))
            .map_err(io)?
            .starts_with(fs::canonicalize(root.join("Herdr.app")).map_err(io)?)
        {
            return Err(Error::SymlinkEscape);
        }
    }
    let candidate = root.join(if mode == Mode::Mac { "Herdr.app" } else { name });
    if seen.is_empty() || !candidate.exists() {
        return Err(Error::EmptyArchive);
    }
    Ok(candidate)
}
