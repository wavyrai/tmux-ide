//! Small app-owned JSON state files. Reads are bounded, writes replace the
//! file atomically, and the latest value is saved on a worker so a change made
//! on the UI thread never waits for the disk.
use serde::Serialize;
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
};

/// The file's bytes, or `None` when it does not exist yet.
pub(crate) fn read(path: &Path, limit: u64) -> crate::Result<Option<Vec<u8>>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(crate::Error::StateFileSize {
            path: path.to_owned(),
            limit,
        });
    }
    Ok(Some(bytes))
}

pub(crate) fn write<T: Serialize + ?Sized>(path: &Path, value: &T) -> crate::Result<()> {
    let parent = path.parent().ok_or(crate::Error::MissingStateRoot)?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    // No fsync: on macOS it is F_FULLFSYNC, which can outlast GPUI's 100 ms
    // quit budget. The rename still replaces the file atomically, and a file
    // torn by power loss is rejected on load in favor of the defaults.
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// Saves the most recent value handed to it. Values replaced before the
/// worker reads them are never written.
pub(crate) struct Writer<T> {
    pending: Arc<Mutex<Option<T>>>,
    wake: mpsc::SyncSender<()>,
    worker: JoinHandle<()>,
}

impl<T: Serialize + Send + 'static> Writer<T> {
    pub(crate) fn start(name: &str, path: PathBuf) -> io::Result<Self> {
        let pending = Arc::new(Mutex::new(None::<T>));
        let mailbox = pending.clone();
        let (wake, receiver) = mpsc::sync_channel(1);
        let label = name.to_owned();
        let worker = thread::Builder::new().name(name.into()).spawn(move || {
            for () in receiver {
                let snapshot = mailbox.lock().ok().and_then(|mut pending| pending.take());
                if let Some(snapshot) = snapshot
                    && let Err(error) = write(&path, &snapshot)
                {
                    tracing::warn!(%error, file = label, "Cannot save state");
                }
            }
        })?;
        Ok(Self {
            pending,
            wake,
            worker,
        })
    }

    pub(crate) fn save(&self, value: T) {
        if let Ok(mut pending) = self.pending.lock() {
            *pending = Some(value);
        }
        // A full wake queue already guarantees that the latest value is read.
        let _ = self.wake.try_send(());
    }

    /// Writes whatever is still pending, then stops the worker. Blocks, so
    /// callers run it off the UI thread.
    pub(crate) fn finish(self) {
        drop(self.wake);
        if self.worker.join().is_err() {
            tracing::warn!("State writer panicked");
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn missing_files_are_empty_and_oversized_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        assert!(read(&path, 8).unwrap().is_none());
        fs::write(&path, b"123456789").unwrap();
        assert!(matches!(
            read(&path, 8),
            Err(crate::Error::StateFileSize { limit: 8, .. })
        ));
        assert_eq!(read(&path, 9).unwrap().unwrap(), b"123456789");
    }

    #[test]
    fn the_latest_value_is_written_before_finish_returns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/state.json");
        let writer = Writer::start("state-test", path.clone()).unwrap();
        writer.save(vec![1]);
        writer.save(vec![2, 3]);
        writer.finish();
        let bytes = read(&path, 1024).unwrap().unwrap();
        assert_eq!(serde_json::from_slice::<Vec<i32>>(&bytes).unwrap(), [2, 3]);
    }
}
