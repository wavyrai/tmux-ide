//! Same-host image leases. Only the trusted broker can supply a filesystem root.
mod reader;
use super::{Blob, Error, Graphics, GraphicsUpdate, MAX_IMAGE_BYTES};
pub(crate) use reader::{ReadEvent, Reader};
use serde::Deserialize;
use std::{
    path::{Component, Path},
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalImages {
    pub root: String,
    pub generation: String,
}
impl LocalImages {
    pub fn validate(&self) -> bool {
        cfg!(unix)
            && self.root.len() <= 4096
            && self.root.starts_with('/')
            && !self.root.contains('\0')
            && uuid::Uuid::parse_str(&self.generation).is_ok()
            && Path::new(&self.root)
                .file_name()
                .is_some_and(|name| name == format!("local-images-{}", self.generation).as_str())
            && Path::new(&self.root)
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LocalFrame {
    #[serde(rename = "type")]
    kind: String,
    pub pane: String,
    pub generation: String,
    pub lease_id: String,
    pub path: String,
    pub expires_at: u64,
    pub blob: Blob,
}
pub(crate) struct Job {
    pub frame: LocalFrame,
    incarnation: String,
    pub cancelled: std::sync::atomic::AtomicBool,
}
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(u64::MAX, |d| d.as_millis().try_into().unwrap_or(u64::MAX))
}
impl LocalFrame {
    pub fn parse(raw: &str, root: &LocalImages) -> Result<Self, Error> {
        let value: Self = serde_json::from_str(raw).map_err(Error::Json)?;
        if value.kind != "terminal-graphics-local"
            || value.generation != root.generation
            || uuid::Uuid::parse_str(&value.lease_id).is_err()
            || value.path.len() > 4096
            || value.path.contains('\0')
            || value.blob.offset != 0
            || value.blob.total == 0
            || value.blob.total > MAX_IMAGE_BYTES
            || !super::wire::digest(&value.blob.digest)
            || !(1..=10_000).contains(&value.blob.width)
            || !(1..=10_000).contains(&value.blob.height)
            || value.expires_at > 9_007_199_254_740_991
        {
            return Err(Error::Metadata);
        }
        // Exactly one store directory and one full content digest; no arbitrary relative traversal.
        let relative = Path::new(&value.path)
            .strip_prefix(&root.root)
            .map_err(|_| Error::Identity)?;
        let parts = relative.components().collect::<Vec<_>>();
        if parts.len() != 2 || !parts.iter().all(|p| matches!(p, Component::Normal(_))) {
            return Err(Error::Identity);
        }
        let directory = parts[0].as_os_str().to_str().ok_or(Error::Identity)?;
        let digest = parts[1].as_os_str().to_str().ok_or(Error::Identity)?;
        if directory.len() != 19
            || !directory.starts_with("local-images-")
            || !directory[13..].bytes().all(|b| b.is_ascii_alphanumeric())
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !digest.starts_with(&value.blob.digest)
        {
            return Err(Error::Identity);
        }
        Ok(value)
    }
    pub fn fresh(&self) -> bool {
        let now = now_ms();
        self.expires_at > now && self.expires_at.saturating_sub(now) <= 60_000
    }
}
impl Graphics {
    pub(crate) fn local_discard(&mut self, job: &Job) -> bool {
        if self
            .partials
            .get(&job.frame.blob.digest)
            .is_some_and(|partial| partial.pane == job.frame.pane)
        {
            self.missing(std::slice::from_ref(&job.frame.blob.digest));
            return true;
        }
        false
    }

    pub(crate) fn local_retry(&mut self, job: &Job, now: Instant) {
        self.missing(std::slice::from_ref(&job.frame.blob.digest));
        self.remember(&job.frame.blob.digest, false, now);
    }

    pub(crate) fn local_job(&self, frame: LocalFrame) -> Result<Option<Arc<Job>>, Error> {
        let pane = self.panes.get(&frame.pane).ok_or(Error::Identity)?;
        if self.retired {
            return Err(Error::Retired);
        }
        if pane.tombstone {
            return Ok(None);
        }
        if pane
            .state
            .as_ref()
            .is_none_or(|s| s.local_files != Some(true))
        {
            return Err(Error::Identity);
        }
        let Some(image) = pane
            .state
            .as_ref()
            .and_then(|s| s.images.iter().find(|i| i.digest == frame.blob.digest))
        else {
            return Ok(None);
        };
        if !frame.blob.matches(image) {
            return Err(Error::Metadata);
        }
        Ok(Some(Arc::new(Job {
            frame,
            incarnation: pane.incarnation.clone().ok_or(Error::Identity)?,
            cancelled: std::sync::atomic::AtomicBool::new(false),
        })))
    }
    pub(crate) fn local_current(&self, job: &Job) -> bool {
        !self.retired
            && self.panes.get(&job.frame.pane).is_some_and(|p| {
                !p.tombstone
                    && p.incarnation.as_ref() == Some(&job.incarnation)
                    && p.state.as_ref().is_some_and(|s| {
                        s.local_files == Some(true)
                            && s.images.iter().any(|i| job.frame.blob.matches(i))
                    })
            })
    }
    pub(crate) fn local_chunk(
        &mut self,
        job: &Job,
        offset: usize,
        bytes: Vec<u8>,
        now: Instant,
    ) -> Result<Option<GraphicsUpdate>, Error> {
        if !self.local_current(job) || !job.frame.fresh() {
            return Ok(None);
        }
        let mut blob = job.frame.blob.clone();
        blob.offset = offset;
        self.blob(&job.frame.pane, blob, bytes, now).map(Some)
    }
}
