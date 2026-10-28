//! Shared config is read-only on Windows. Native GUI overrides use config.rs's
//! portable writer; that writer cannot preserve the shared file's Unix safety
//! contract (owner/ACL validation and descriptor-relative replacement).
use super::Error;
use std::{fs, io::Read as _, path::Path};

pub(super) const LIMIT: u64 = 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub text: Option<String>,
}

pub(super) fn read(path: &Path) -> Result<Snapshot, Error> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Snapshot::default());
        }
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(Error::UnsafePath);
    }
    if metadata.len() > LIMIT {
        return Err(Error::TooLarge);
    }
    let mut text = String::new();
    file.take(LIMIT + 1).read_to_string(&mut text)?;
    if text.len() as u64 > LIMIT {
        return Err(Error::TooLarge);
    }
    Ok(Snapshot { text: Some(text) })
}

pub(super) fn save(_: &Path, _: &Snapshot, _: &str) -> Result<Snapshot, Error> {
    // Do not create directories, lock files, or temporary files on this path.
    Err(Error::Unsupported)
}
