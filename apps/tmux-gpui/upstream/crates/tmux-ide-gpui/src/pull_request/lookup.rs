//! The single prefetch worker and the handle that talks to it. One request is
//! in flight at a time; a superseded request is dropped by generation rather
//! than cancelled mid-flight, and dropping the handle retires the generation.

use super::{Input, Origin, Origins, PullRequest, Result, fetch_with_backoff};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

type Request = (u64, Input, Origin, Arc<secrecy::SecretString>);

pub(super) struct Worker {
    pub(super) requests: mpsc::SyncSender<Request>,
    pub(super) results: mpsc::Receiver<(u64, Result, Option<Duration>)>,
}

#[derive(Default)]
pub(crate) struct Lookup {
    pub(super) worker: Option<Worker>,
    pub(super) generation: Arc<AtomicU64>,
    pub(super) busy: bool,
    pub(super) waiting: Option<(Input, Origin, Arc<secrecy::SecretString>)>,
    pub loading: bool,
    pub value: Option<PullRequest>,
    pub message: Option<String>,
    pub checked: Option<Instant>,
    pub(super) cooldown: Option<Duration>,
}

impl Drop for Lookup {
    fn drop(&mut self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
    }
}

impl Lookup {
    pub fn clear(&mut self) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        // Sign-out also drains already-queued private results without scheduling
        // more work. A still-running cancelled request is drained on a later tick.
        if let Some(worker) = &self.worker
            && worker.results.try_recv().is_ok()
        {
            self.busy = false;
        }
        self.waiting = None;
        self.loading = false;
        self.value = None;
        self.message = None;
        self.checked = None;
        self.cooldown = None;
    }

    pub fn request(&mut self, input: Input, origin: Origin, token: Arc<secrecy::SecretString>) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.waiting = Some((input, origin, token));
        self.loading = true;
        self.message = None;
    }

    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        if let Some(worker) = &self.worker {
            match worker.results.try_recv() {
                Ok((generation, result, cooldown)) => {
                    self.busy = false;
                    if generation == self.generation.load(Ordering::Relaxed) {
                        self.loading = false;
                        self.checked = Some(Instant::now());
                        self.cooldown = cooldown;
                        match result {
                            Ok(value) => {
                                self.value = value;
                                self.message = None;
                            }
                            Err(error) => self.message = Some(error.to_string()),
                        }
                        changed = true;
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.busy = false;
                    self.loading = false;
                    self.waiting = None;
                    self.message = Some("PR worker stopped; retrying automatically.".into());
                    self.worker = None;
                    return true;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if !self.busy
            && let Some((input, origin, token)) = self.waiting.take()
        {
            if self.worker.is_none() {
                let (requests, incoming) = mpsc::sync_channel::<Request>(1);
                let (outgoing, results) = mpsc::sync_channel(1);
                let current = self.generation.clone();
                match thread::Builder::new()
                    .name("herdr-pr".into())
                    .spawn(move || {
                        // Remote repositories are resolved over SSH; remember
                        // them so a refresh does not dial the host again.
                        let mut origins = Origins::default();
                        for (generation, input, origin, token) in incoming {
                            let mut cooldown = None;
                            let result = fetch_with_backoff(
                                &input,
                                &origin,
                                &mut origins,
                                &token,
                                || current.load(Ordering::Relaxed) != generation,
                                &mut cooldown,
                            );
                            if outgoing.send((generation, result, cooldown)).is_err() {
                                break;
                            }
                        }
                    }) {
                    Ok(_) => self.worker = Some(Worker { requests, results }),
                    Err(_) => {
                        self.loading = false;
                        self.message = Some("Could not start PR worker.".into());
                        return true;
                    }
                }
            }
            if let Some(worker) = &self.worker {
                self.busy = worker
                    .requests
                    .try_send((
                        self.generation.load(Ordering::Relaxed),
                        input,
                        origin,
                        token,
                    ))
                    .is_ok();
            }
        }
        changed
    }
}
