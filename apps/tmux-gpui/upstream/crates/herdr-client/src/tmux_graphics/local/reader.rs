//! Blocking file access runs only on this dedicated bounded worker.
use super::{Job, LocalImages};
#[cfg(unix)]
use crate::tmux_graphics::CHUNK_BYTES;
use crossbeam_channel::{Receiver, Sender, bounded};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
pub(crate) enum ReadEvent {
    Chunk {
        job: Arc<Job>,
        offset: usize,
        bytes: Vec<u8>,
        complete: bool,
    },
    Failed(Arc<Job>),
}
pub(crate) struct Reader {
    jobs: Sender<Arc<Job>>,
    pub events: Receiver<ReadEvent>,
    cancelled: Arc<AtomicBool>,
}
impl Reader {
    pub fn spawn(root: LocalImages) -> std::io::Result<Self> {
        let (jobs, receive) = bounded::<Arc<Job>>(8);
        let (send, events) = bounded(2);
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&cancelled);
        thread::Builder::new()
            .name("tmux-local-images".into())
            .spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let job = match receive.recv() {
                        Ok(job) => job,
                        Err(_) => break,
                    };
                    if read(&root, &job, &send, &stop).is_err()
                        && !emit(&send, ReadEvent::Failed(job), &stop)
                    {
                        break;
                    }
                }
            })?;
        Ok(Self {
            jobs,
            events,
            cancelled,
        })
    }
    pub fn submit(&self, job: Arc<Job>) -> bool {
        self.jobs.try_send(job).is_ok()
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}
fn emit(send: &Sender<ReadEvent>, mut event: ReadEvent, stop: &AtomicBool) -> bool {
    loop {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        match send.send_timeout(event, Duration::from_millis(50)) {
            Ok(()) => return true,
            Err(crossbeam_channel::SendTimeoutError::Timeout(value)) => event = value,
            Err(_) => return false,
        }
    }
}
#[cfg(unix)]
fn read(
    root: &LocalImages,
    job: &Arc<Job>,
    send: &Sender<ReadEvent>,
    stop: &AtomicBool,
) -> std::io::Result<()> {
    use rustix::fs::{Mode, OFlags, open, openat};
    use sha2::{Digest, Sha256};
    use std::{
        fs::File,
        io::{Error, ErrorKind, Read},
        os::unix::fs::MetadataExt,
        path::{Component, Path},
    };
    let reject = || Error::new(ErrorKind::InvalidData, "invalid local image lease");
    if !root.validate() || !job.frame.fresh() || job.cancelled.load(Ordering::Acquire) {
        return Err(reject());
    }
    let flags = OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::DIRECTORY;
    let mut directory = open("/", flags, Mode::empty())?;
    for component in Path::new(&root.root).components() {
        if let Component::Normal(name) = component {
            directory = openat(&directory, name, flags, Mode::empty())?;
        }
    }
    let check_dir = |file: &File| -> std::io::Result<()> {
        let m = file.metadata()?;
        if !m.is_dir() || m.uid() != rustix::process::getuid().as_raw() || m.mode() & 0o077 != 0 {
            return Err(reject());
        }
        Ok(())
    };
    let root_file = File::from(directory);
    check_dir(&root_file)?;
    let path = Path::new(&job.frame.path);
    let relative = path.strip_prefix(&root.root).map_err(|_| reject())?;
    let store = relative.parent().ok_or_else(reject)?;
    let directory = File::from(openat(&root_file, store, flags, Mode::empty())?);
    check_dir(&directory)?;
    let name = path.file_name().ok_or_else(reject)?;
    let mut file = File::from(openat(
        &directory,
        name,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )?);
    let before = file.metadata()?;
    if !before.is_file()
        || before.uid() != rustix::process::getuid().as_raw()
        || before.mode() & 0o777 != 0o400
        || before.len() != job.frame.blob.total as u64
        || before.nlink() != 1
    {
        return Err(reject());
    }
    let mut hash = Sha256::new();
    let mut offset = 0;
    while offset < job.frame.blob.total {
        if stop.load(Ordering::Acquire)
            || job.cancelled.load(Ordering::Acquire)
            || !job.frame.fresh()
        {
            return Err(reject());
        }
        let mut bytes = vec![0; CHUNK_BYTES.min(job.frame.blob.total - offset)];
        file.read_exact(&mut bytes)?;
        hash.update(&bytes);
        let complete = offset + bytes.len() == job.frame.blob.total;
        if complete {
            let digest = hash
                .clone()
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let after = file.metadata()?;
            let mut extra = [0];
            if file.read(&mut extra)? != 0
                || digest.as_str() != name.to_str().ok_or_else(reject)?
                || !digest.starts_with(&job.frame.blob.digest)
                || before.dev() != after.dev()
                || before.ino() != after.ino()
                || before.len() != after.len()
                || before.mode() != after.mode()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
                || !job.frame.fresh()
            {
                return Err(reject());
            }
        }
        let length = bytes.len();
        if !emit(
            send,
            ReadEvent::Chunk {
                job: Arc::clone(job),
                offset,
                bytes,
                complete,
            },
            stop,
        ) {
            return Err(reject());
        }
        offset += length;
    }
    Ok(())
}
#[cfg(not(unix))]
fn read(
    _: &LocalImages,
    _: &Arc<Job>,
    _: &Sender<ReadEvent>,
    _: &AtomicBool,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "local images unavailable",
    ))
}

#[cfg(all(test, unix))]
#[path = "reader_tests.rs"]
mod tests;
