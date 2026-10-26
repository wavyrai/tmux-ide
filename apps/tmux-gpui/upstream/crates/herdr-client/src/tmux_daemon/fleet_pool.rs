//! Background-actor-only catalog ownership. At most four catalog operations run
//! concurrently; idle routes retain their authenticated source, not a worker
//! thread. No terminal streams or mutations are issued by this pool.
use super::{
    CatalogAction, CatalogIdentity, CatalogResult, CatalogSource, CatalogWorker, Error,
    FleetCatalog, WorkerError,
};
use std::collections::{BTreeMap, VecDeque};
const MAX_ROUTES: usize = 65; // Local plus the saved-registry limit.
const MAX_ACTIVE: usize = 4;

#[derive(Debug, thiserror::Error)]
pub enum FleetPoolError {
    #[error("fleet route is missing, duplicated or exceeds the catalog limit")]
    Route,
    #[error("fleet catalog worker failed")]
    Worker(#[from] WorkerError),
    #[error("fleet route shutdown failed")]
    Shutdown(#[source] Error),
}
pub struct FleetCatalogEvent {
    pub route_id: String,
    /// A private insertion identity. Replacing a route always creates a new one.
    pub incarnation: uuid::Uuid,
    pub result: Result<FleetCatalog, Error>,
}
struct Entry {
    source: CatalogSource,
    catalog_identity: Option<CatalogIdentity>,
    incarnation: uuid::Uuid,
    worker: Option<CatalogWorker>,
    queued: bool,
    watch: Option<super::CatalogWatchWorker>,
    watch_failed: bool,
}
/// Call and drop only on a background owner, since retiring SSH may wait for its
/// exact owned process. Registry policy and published selection tokens belong to
/// the caller; an event itself grants no selection authority.
#[derive(Default)]
pub struct FleetCatalogPool {
    entries: BTreeMap<String, Entry>,
    queue: VecDeque<String>,
    notifications: bool,
}
impl FleetCatalogPool {
    pub(super) fn enable_notifications(&mut self) {
        self.notifications = true;
    }
    pub fn insert(
        &mut self,
        id: String,
        source: CatalogSource,
    ) -> Result<uuid::Uuid, FleetPoolError> {
        if id.is_empty() || self.entries.contains_key(&id) || self.entries.len() == MAX_ROUTES {
            return Err(FleetPoolError::Route);
        }
        let incarnation = uuid::Uuid::new_v4();
        self.entries.insert(
            id.clone(),
            Entry {
                source,
                catalog_identity: None,
                incarnation,
                worker: None,
                queued: true,
                watch: None,
                watch_failed: false,
            },
        );
        self.queue.push_back(id);
        Ok(incarnation)
    }
    /// Explicit refresh coalesces to one queued read per route, including while a
    /// read is active. It never resets transport authority or replays mutations.
    pub fn refresh(&mut self, id: &str) -> Result<(), FleetPoolError> {
        let entry = self.entries.get_mut(id).ok_or(FleetPoolError::Route)?;
        if entry.watch_failed {
            return Ok(());
        }
        if !entry.queued {
            entry.queued = true;
            self.queue.push_back(id.into());
        }
        Ok(())
    }
    pub fn incarnation(&self, id: &str) -> Option<uuid::Uuid> {
        self.entries.get(id).map(|entry| entry.incarnation)
    }
    /// Borrow the existing source after a successful catalog. No discovery or
    /// connection is started here; the pool remains its sole shutdown owner.
    pub(super) fn observation_source(
        &self,
        id: &str,
        incarnation: uuid::Uuid,
        identity: &CatalogIdentity,
    ) -> Option<CatalogSource> {
        let entry = self.entries.get(id)?;
        (entry.incarnation == incarnation
            && entry.catalog_identity.as_ref() == Some(identity)
            && !entry.watch_failed)
            .then(|| entry.source.clone())
    }
    pub fn busy(&self) -> bool {
        !self.queue.is_empty() || self.entries.values().any(|entry| entry.worker.is_some())
    }
    /// Cancellation clears the old mailbox before shutdown. On shutdown failure
    /// retain ownership so a caller can retry instead of abandoning the process.
    pub fn remove(&mut self, id: &str) -> Result<(), FleetPoolError> {
        let Some(entry) = self.entries.get_mut(id) else {
            return Ok(());
        };
        entry.catalog_identity = None;
        entry.watch.take();
        entry.worker.take();
        entry.queued = false;
        self.queue.retain(|queued| queued != id);
        entry.source.shutdown().map_err(FleetPoolError::Shutdown)?;
        self.entries.remove(id);
        Ok(())
    }
    pub fn poll(&mut self) -> Result<Vec<FleetCatalogEvent>, FleetPoolError> {
        let mut events = Vec::new();
        let mut invalidated = Vec::new();
        for (id, entry) in &mut self.entries {
            let notice = match entry.watch.as_ref().map(|watch| watch.poll()).transpose() {
                Ok(value) => value.flatten(),
                Err(error) => {
                    entry.catalog_identity = None;
                    return Err(error.into());
                }
            };
            if let Some(notice) = notice {
                match notice {
                    Ok(()) => invalidated.push(id.clone()),
                    Err(error) => {
                        entry.catalog_identity = None;
                        entry.watch.take();
                        entry.worker.take();
                        entry.watch_failed = true;
                        entry.queued = false;
                        self.queue.retain(|queued| queued != id);
                        events.push(FleetCatalogEvent {
                            route_id: id.clone(),
                            incarnation: entry.incarnation,
                            result: Err(Error::CatalogWatch(Box::new(error))),
                        });
                    }
                }
            }
            let Some(worker) = &mut entry.worker else {
                continue;
            };
            let polled = match worker.poll() {
                Ok(value) => value,
                Err(error) => {
                    entry.catalog_identity = None;
                    return Err(error.into());
                }
            };
            if let Some(result) = polled {
                entry.catalog_identity = None;
                entry.worker.take();
                let result = result.and_then(|result| match result {
                    CatalogResult::FleetCatalog(catalog) => Ok(catalog),
                    _ => Err(Error::ResourceFormat),
                });
                if self.notifications
                    && entry.watch.is_none()
                    && !entry.watch_failed
                    && let Ok(catalog) = &result
                {
                    let actor = std::thread::current();
                    entry.watch = Some(super::CatalogWatchWorker::spawn(
                        entry.source.clone(),
                        catalog.identity.clone(),
                        move || actor.unpark(),
                    )?);
                }
                entry.catalog_identity =
                    result.as_ref().ok().map(|catalog| catalog.identity.clone());
                events.push(FleetCatalogEvent {
                    route_id: id.clone(),
                    incarnation: entry.incarnation,
                    result,
                });
            }
        }
        for id in invalidated {
            self.refresh(&id)?;
        }
        let mut available = MAX_ACTIVE.saturating_sub(
            self.entries
                .values()
                .filter(|entry| entry.worker.is_some())
                .count(),
        );
        // Inspect each queued item once: a refresh of a busy route cannot prevent
        // a later machine from using an available slot.
        for _ in 0..self.queue.len() {
            if available == 0 {
                break;
            }
            let Some(id) = self.queue.pop_front() else {
                break;
            };
            let Some(entry) = self.entries.get_mut(&id) else {
                continue;
            };
            if entry.worker.is_some() {
                self.queue.push_back(id);
                continue;
            }
            let started = (|| {
                let mut worker = CatalogWorker::spawn_source(entry.source.clone())?;
                worker.submit(CatalogAction::FleetCatalog)?;
                Ok::<_, WorkerError>(worker)
            })();
            match started {
                Ok(worker) => {
                    entry.queued = false;
                    entry.worker = Some(worker);
                    available -= 1;
                }
                Err(error) => {
                    entry.catalog_identity = None;
                    self.queue.push_front(id);
                    return Err(error.into());
                }
            }
        }
        Ok(events)
    }
    pub fn shutdown(&mut self) -> Result<(), FleetPoolError> {
        let ids: Vec<_> = self.entries.keys().cloned().collect();
        let mut first_error = None;
        for id in ids {
            if let Err(error) = self.remove(&id) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}
impl Drop for FleetCatalogPool {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[cfg(test)]
#[path = "fleet_pool_limits_tests.rs"]
mod tests;
