//! A worktree or workspace being created on another host. It runs on its own
//! named thread and reports through a channel the window drains on its tick.
//! Closing the dialog does not stop it, since stopping halfway could leave a
//! clone or a stray reference behind; only closing the window does.

use crate::teleport::{self, Created, FreshOrigin, HostRepositories, Naming, Step};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};

enum Event {
    Step(Step),
    Done(Result<Created, teleport::Error>),
}

pub(crate) struct Job {
    /// The destination's name, for the dialog and the flash.
    pub(crate) host: String,
    /// The repository's name, recorded in the history once the job succeeds.
    pub(crate) repo: String,
    step: Option<Step>,
    events: mpsc::Receiver<Event>,
    cancelled: Arc<AtomicBool>,
}

impl Drop for Job {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

impl Job {
    fn spawn(
        host: String,
        repo: String,
        work: impl FnOnce(&mut dyn FnMut(Step), &AtomicBool) -> Result<Created, teleport::Error>
        + Send
        + 'static,
    ) -> Self {
        let (sender, events) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let spawned = std::thread::Builder::new()
            .name("herdr-dispatch".into())
            .spawn(move || {
                let steps = sender.clone();
                let mut report = move |step| {
                    let _ = steps.send(Event::Step(step));
                };
                let _ = sender.send(Event::Done(work(&mut report, &flag)));
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "could not start the dispatch worker");
        }
        Self {
            host,
            repo,
            step: None,
            events,
            cancelled,
        }
    }

    /// Create a worktree of `origin`'s repository from `base` on `destination`.
    pub(crate) fn worktree(
        origin: FreshOrigin,
        destination: HostRepositories,
        base: String,
        naming: Naming,
    ) -> Self {
        Self::spawn(
            destination.place.label.clone(),
            origin.repo_label.clone(),
            move |report, cancelled| {
                teleport::dispatch_worktree(
                    &origin,
                    &destination,
                    &base,
                    &naming,
                    report,
                    cancelled,
                )
            },
        )
    }

    /// Open `origin`'s repository as a new workspace on `destination`.
    pub(crate) fn workspace(
        origin: FreshOrigin,
        destination: HostRepositories,
        label: Option<String>,
    ) -> Self {
        Self::spawn(
            destination.place.label.clone(),
            origin.repo_label.clone(),
            move |report, cancelled| {
                teleport::dispatch_workspace(
                    &origin,
                    &destination,
                    label.as_deref(),
                    report,
                    cancelled,
                )
            },
        )
    }

    /// Take reported steps. Returns whether the status changed, and the
    /// outcome once, with its failure as display text.
    pub(crate) fn poll(&mut self) -> (bool, Option<Result<Created, String>>) {
        let mut changed = false;
        while let Ok(event) = self.events.try_recv() {
            changed = true;
            match event {
                Event::Step(step) => self.step = Some(step),
                Event::Done(result) => {
                    return (
                        true,
                        Some(result.map_err(|error| {
                            tracing::warn!(%error, host = %self.host, "dispatch");
                            error.to_string()
                        })),
                    );
                }
            }
        }
        (changed, None)
    }

    /// What the job is doing, for the dialog.
    pub(crate) fn status(&self) -> String {
        match self.step {
            None => format!("Starting on {}...", self.host),
            Some(step) => format!("On {}: {}...", self.host, step.label()),
        }
    }
}
