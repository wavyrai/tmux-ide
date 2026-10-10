//! Machines being added, owned by the window rather than a dialog: a build can
//! take minutes, so the dialog closes at once and each job runs on its own
//! worker. The device picker lists them with their latest status; a toast
//! reports each one ready (or not added). Closing the window drops the jobs,
//! which cancels them. Nothing here knows a provider's API: a job is the
//! provider's own work, reporting the shared [`Step`]s.

use super::worker::{self, Worker};
use super::{CloudProvider, SavedDevice, Step};
use crate::HerdrWindow;
use gpui::Context;

enum Update {
    Step(Step),
    Finished(crate::Result<SavedDevice>),
}

pub(crate) struct Job {
    id: u64,
    pub(crate) provider: CloudProvider,
    pub(crate) name: String,
    pub(crate) status: String,
    _worker: Worker,
}

#[derive(Default)]
pub(crate) struct Jobs {
    jobs: Vec<Job>,
    next: u64,
    /// How many jobs have finished, so a view showing saved devices (such as
    /// Settings) can tell when to read them again.
    finished: u64,
}

impl Jobs {
    pub(crate) fn iter(&self) -> impl Iterator<Item = &Job> {
        self.jobs.iter()
    }

    pub(crate) fn len(&self) -> usize {
        self.jobs.len()
    }

    pub(crate) fn finished(&self) -> u64 {
        self.finished
    }

    /// Count a job as finished without running one.
    #[cfg(test)]
    pub(crate) fn finish_for_test(&mut self) {
        self.finished += 1;
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    /// Whether a job already adds a machine of this provider with this name.
    #[cfg(feature = "coder")]
    pub(crate) fn contains(&self, provider: CloudProvider, name: &str) -> bool {
        self.jobs
            .iter()
            .any(|job| job.provider == provider && job.name == name)
    }
}

impl HerdrWindow {
    /// Run `work` to add the machine `name` from `provider`; it reports
    /// through the picker and a toast. `work` blocks on its own worker.
    pub(crate) fn start_cloud_job(
        &mut self,
        provider: CloudProvider,
        name: String,
        work: impl FnOnce(&dyn Fn() -> bool, &dyn Fn(Step)) -> crate::Result<SavedDevice>
        + Send
        + 'static,
        cx: &mut Context<Self>,
    ) -> crate::Result<()> {
        if let Some(reason) = super::unavailable() {
            return Err(super::Error::Unavailable(reason).into());
        }
        let id = self.cloud_jobs.next;
        self.cloud_jobs.next += 1;
        let worker = worker::spawn(
            "herdr-cloud-job",
            cx,
            move |cancelled, send| {
                let result = work(cancelled, &|step| send(Update::Step(step)));
                send(Update::Finished(result));
            },
            move |this: &mut Self, update, cx| this.apply_cloud_job(id, update, cx),
        )
        .map_err(|error| {
            tracing::error!(category = "cloud_worker", error_kind = ?error.kind(), "Could not start cloud job worker");
            super::Error::Worker("job")
        })?;
        self.cloud_jobs.jobs.push(Job {
            id,
            provider,
            name,
            status: format!("Contacting {}…", super::name(provider)),
            _worker: worker,
        });
        cx.notify();
        Ok(())
    }

    fn apply_cloud_job(&mut self, id: u64, update: Update, cx: &mut Context<Self>) {
        let Some(index) = self.cloud_jobs.jobs.iter().position(|job| job.id == id) else {
            return;
        };
        match update {
            Update::Step(step) => self.cloud_jobs.jobs[index].status = step.text(),
            Update::Finished(result) => {
                let job = self.cloud_jobs.jobs.remove(index);
                self.cloud_jobs.finished += 1;
                let (name, noun) = (super::name(job.provider), super::noun(job.provider));
                match result {
                    Ok(saved) => self.local_transfer_notice(
                        &format!("{name} {noun} ready"),
                        format!(
                            "{} is ready. Choose it in the device picker to start working.",
                            saved.label
                        ),
                        cx,
                    ),
                    Err(error) => self.local_transfer_notice(
                        &format!("{name} {noun} not added"),
                        format!("{}: {error}", job.name),
                        cx,
                    ),
                }
            }
        }
        cx.notify();
    }
}
