//! Slow ancestry discovery has a separate bounded worker so lazy readiness never
//! stalls session navigation. Replies remain scoped to one terminal route/epoch.
use super::*;
use herdr_client::tmux_control::WindowLink;
struct Pending {
    id: String,
    request: u64,
    sequence: u64,
}
struct Queued {
    pending: Pending,
    action: CatalogAction,
}
pub(super) struct Reader {
    worker: CatalogWorker,
    pending: Option<Pending>,
    queued: Option<Queued>,
}
impl Reader {
    #[cfg(test)]
    pub fn new(record: PathBuf) -> Result<Self, WorkerError> {
        Self::from_source(CatalogSource::Local(record))
    }
    pub fn from_source(source: CatalogSource) -> Result<Self, WorkerError> {
        Ok(Self {
            worker: CatalogWorker::spawn_source(source)?,
            pending: None,
            queued: None,
        })
    }
    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }
    pub fn reset(&mut self) {
        self.worker.reset();
        self.pending = None;
        self.queued = None;
    }
    pub fn cancel(&mut self) {
        self.worker.cancel();
        self.pending = None;
        self.queued = None;
    }
    pub fn request(
        &mut self,
        route: Option<&Route>,
        id: String,
        request: u64,
        sequence: u64,
        window: WindowLink,
    ) -> Result<Option<SplitResponse>, Error> {
        let failed = || {
            Some(SplitResponse {
                id: id.clone(),
                request,
                sequence,
                resource: None,
            })
        };
        let Some(route) = route.filter(|r| {
            r.id == id && r.request == request && r.target.live == window.live_session_id
        }) else {
            return Ok(failed());
        };
        let job = Queued {
            pending: Pending {
                id,
                request,
                sequence,
            },
            action: CatalogAction::SplitLayout {
                scope: route.target.scope.clone(),
                workspace: route.workspace.clone(),
                window,
            },
        };
        if let Some(previous) = self
            .queued
            .as_ref()
            .map(|q| &q.pending)
            .or(self.pending.as_ref())
        {
            if previous.id == job.pending.id
                && previous.request == request
                && sequence <= previous.sequence
            {
                return Ok(None);
            }
            // Geometry and the mutation receipt may request successive reads.
            // Keep only the newest observation; never replay a resize mutation.
            self.queued = Some(job);
            return Ok(None);
        }
        self.submit(job)
    }
    fn failed(pending: Pending) -> SplitResponse {
        SplitResponse {
            id: pending.id,
            request: pending.request,
            sequence: pending.sequence,
            resource: None,
        }
    }
    fn submit(&mut self, job: Queued) -> Result<Option<SplitResponse>, Error> {
        match self.worker.submit(job.action) {
            Ok(()) => {
                self.pending = Some(job.pending);
                Ok(None)
            }
            Err(WorkerError::Busy) => Ok(Some(Self::failed(job.pending))),
            Err(error) => Err(error.into()),
        }
    }

    pub fn poll(&mut self, route: Option<&Route>) -> Result<Option<SplitResponse>, Error> {
        let Some(result) = self.worker.poll()? else {
            return Ok(None);
        };
        let Some(pending) = self.pending.take() else {
            return Ok(None);
        };
        if let Some(job) = self.queued.take()
            && route.is_some_and(|r| r.id == job.pending.id && r.request == job.pending.request)
            && let Some(failed) = self.submit(job)?
        {
            return Ok(Some(failed));
        }
        if !route.is_some_and(|r| r.id == pending.id && r.request == pending.request) {
            return Ok(None);
        }
        let resource = match result {
            Ok(CatalogResult::SplitLayout(resource)) => Some(resource),
            _ => None,
        };
        Ok(Some(SplitResponse {
            id: pending.id,
            request: pending.request,
            sequence: pending.sequence,
            resource,
        }))
    }
}

#[cfg(test)]
#[path = "browser_native_local_split_tests.rs"]
mod tests;
