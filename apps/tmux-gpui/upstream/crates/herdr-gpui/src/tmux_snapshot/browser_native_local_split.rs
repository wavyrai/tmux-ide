//! Slow ancestry discovery has a separate bounded worker so lazy readiness never
//! stalls session navigation. Replies remain scoped to one terminal route/epoch.
use super::*;
use herdr_client::tmux_control::WindowLink;
struct Pending {
    id: String,
    request: u64,
    sequence: u64,
}
pub(super) struct Reader {
    worker: CatalogWorker,
    pending: Option<Pending>,
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
        })
    }
    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }
    pub fn reset(&mut self) {
        self.worker.reset();
        self.pending = None;
    }
    pub fn cancel(&mut self) {
        self.worker.cancel();
        self.pending = None;
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
        if self.pending.is_some() {
            return Ok(failed());
        }
        match self.worker.submit(CatalogAction::SplitLayout {
            scope: route.target.scope.clone(),
            workspace: route.workspace.clone(),
            window,
        }) {
            Ok(()) => {
                self.pending = Some(Pending {
                    id,
                    request,
                    sequence,
                });
                Ok(None)
            }
            Err(WorkerError::Busy) => Ok(failed()),
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
