//! Coalesced change notifications. Consumers re-read before applying authority;
//! a watch snapshot never races a newer foreground mutation receipt into the UI.
use super::{Error, LocalDaemon, MachineWatchCancellation, WorkerError};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

pub struct MachineWatchWorker {
    cancellation: MachineWatchCancellation,
    mailbox: Arc<Mutex<Option<Result<(), Error>>>>,
    thread: thread::Thread,
    finished: mpsc::Receiver<()>,
}
impl MachineWatchWorker {
    pub fn spawn(record: PathBuf, wake: impl Fn() + Send + 'static) -> Result<Self, WorkerError> {
        let cancellation = MachineWatchCancellation::default();
        let stop = cancellation.clone();
        let mailbox = Arc::new(Mutex::new(None));
        let output = mailbox.clone();
        let (finished, done) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("tmux-registry-watch".into())
            .spawn(move || {
                let mut daemon = None;
                let mut revision = None;
                let mut failed = false;
                while stop.check().is_ok() {
                    let result = (|| {
                        if daemon.is_none() {
                            daemon = Some(LocalDaemon::discover(&record)?);
                        }
                        let owner = daemon.as_ref().ok_or(Error::Retired)?;
                        owner.watch_saved_machines(revision.as_deref(), &stop)
                    })();
                    if stop.check().is_err() {
                        break;
                    }
                    let notice = match result {
                        Ok(update) => {
                            failed = false;
                            let changed = update.registry.is_some();
                            revision = Some(update.revision);
                            changed.then_some(Ok(()))
                        }
                        Err(error) => {
                            daemon = None;
                            revision = None;
                            let notify = !failed;
                            failed = true;
                            notify.then_some(Err(error))
                        }
                    };
                    if let Some(notice) = notice {
                        if let Ok(mut slot) = output.lock() {
                            // Retain a failure until observed even if recovery follows it.
                            if !matches!(*slot, Some(Err(_))) {
                                *slot = Some(notice);
                            }
                        } else {
                            break;
                        }
                        wake();
                    }
                    if failed {
                        thread::park_timeout(Duration::from_secs(1));
                    }
                }
                let _ = finished.send(());
            })
            .map_err(WorkerError::Spawn)?;
        Ok(Self {
            cancellation,
            mailbox,
            thread: worker.thread().clone(),
            finished: done,
        })
    }
    pub fn poll(&self) -> Result<Option<Result<(), Error>>, WorkerError> {
        Ok(self.mailbox.lock().map_err(|_| WorkerError::Closed)?.take())
    }
    pub fn cancel(&self) {
        self.cancellation.cancel();
        self.thread.unpark();
    }
    /// Background shutdown only. Discovery/connect are individually bounded;
    /// the longer watch itself is interrupted by shutting down its exact socket.
    pub fn shutdown(&self) -> Result<(), Error> {
        self.cancel();
        match self.finished.recv_timeout(Duration::from_secs(8)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(Error::Retired),
        }
    }
}
impl Drop for MachineWatchWorker {
    fn drop(&mut self) {
        self.cancel();
    }
}
