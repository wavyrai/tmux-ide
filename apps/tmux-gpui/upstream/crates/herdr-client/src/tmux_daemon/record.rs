use super::Error;
#[cfg(unix)]
use super::LIMIT;
use serde::Deserialize;
use std::path::Path;
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Record {
    pub pid: u32,
    port: u16,
    pub protocol_version: u32,
    pub product_version: String,
    pub instance_id: String,
    pub started_at: String,
    #[serde(default, deserialize_with = "super::optional_string")]
    pub environment_id: Option<String>,
    bind_hostname: String,
    // Kept private until the authenticated owner client is built on this proof.
    auth_token: String,
}
impl Record {
    #[cfg(unix)]
    fn validate(&self) -> Result<(), Error> {
        if self.pid == 0
            || self.pid > i32::MAX as u32
            || self.port == 0
            || self.protocol_version == 0
            || self.product_version.trim().is_empty()
            || self.auth_token.is_empty()
            || self.instance_id.len() != 36
            || uuid::Uuid::parse_str(&self.instance_id).is_err()
            || self
                .environment_id
                .as_ref()
                .is_some_and(|id| id.len() != 36 || uuid::Uuid::parse_str(id).is_err())
            || chrono::DateTime::parse_from_rfc3339(&self.started_at).is_err()
        {
            return Err(Error::RecordFormat);
        }
        Ok(())
    }
    pub fn authorization(&self) -> Result<ureq::http::HeaderValue, Error> {
        let mut header = ureq::http::HeaderValue::from_str(&format!("Bearer {}", self.auth_token))
            .map_err(|_| Error::RecordFormat)?;
        header.set_sensitive(true);
        Ok(header)
    }
    pub fn endpoint(&self) -> Result<Url, Error> {
        let host = match self.bind_hostname.as_str() {
            "localhost" | "127.0.0.1" => self.bind_hostname.as_str(),
            "::1" | "[::1]" => "[::1]",
            _ => return Err(Error::Endpoint),
        };
        Url::parse(&format!("http://{host}:{}/", self.port)).map_err(|_| Error::Endpoint)
    }
}

#[cfg(unix)]
pub(super) fn read(path: &Path) -> Result<(Record, [u8; 32]), Error> {
    use rustix::fs::{Mode, OFlags, open, openat};
    use sha2::{Digest, Sha256};
    use std::{
        fs::{self, File, Metadata},
        io::Read,
        os::unix::fs::MetadataExt,
    };
    let io = Error::RecordIo;
    let reject = || Error::RecordSecurity;
    let parent = path.parent().ok_or_else(reject)?;
    let name = path.file_name().ok_or_else(reject)?;
    let same = |a: &Metadata, b: &Metadata| a.dev() == b.dev() && a.ino() == b.ino();
    let private =
        |m: &Metadata| m.uid() == rustix::process::getuid().as_raw() && m.mode() & 0o077 == 0;
    let parent_before = fs::symlink_metadata(parent).map_err(io)?;
    if !parent_before.is_dir() || !private(&parent_before) {
        return Err(reject());
    }
    let directory = File::from(
        open(
            parent,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::DIRECTORY,
            Mode::empty(),
        )
        .map_err(|e| io(e.into()))?,
    );
    let pinned_parent = directory.metadata().map_err(io)?;
    if !same(&parent_before, &pinned_parent) || !private(&pinned_parent) {
        return Err(reject());
    }
    let mut file = File::from(
        openat(
            &directory,
            name,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|e| io(e.into()))?,
    );
    let before = file.metadata().map_err(io)?;
    if !before.is_file() || !private(&before) || before.len() > LIMIT || before.nlink() != 1 {
        return Err(reject());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    let after = file.metadata().map_err(io)?;
    let visible = fs::symlink_metadata(path).map_err(io)?;
    let current_parent = fs::symlink_metadata(parent).map_err(io)?;
    if bytes.len() as u64 > LIMIT
        || !same(&before, &visible)
        || !same(&pinned_parent, &current_parent)
        || !current_parent.is_dir()
        || !private(&current_parent)
        || !visible.is_file()
        || !private(&visible)
        || !private(&after)
        || after.nlink() != 1
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(reject());
    }
    let raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| Error::RecordFormat)?;
    if raw
        .as_object()
        .is_none_or(|object| object.contains_key("kind"))
    {
        return Err(Error::RecordFormat);
    }
    let record: Record = serde_json::from_value(raw).map_err(|_| Error::RecordFormat)?;
    record.validate()?;
    Ok((record, Sha256::digest(&bytes).into()))
}

#[cfg(not(unix))]
pub(super) fn read(_path: &Path) -> Result<(Record, [u8; 32]), Error> {
    Err(Error::UnsupportedPlatform)
}
