//! Bounded read-only agent observation. Caller owns source lifetime and refresh
//! policy; cancellation never resets a shared route or replays an action.
use super::{
    AgentObservation, CatalogAction, CatalogResult, CatalogRetirement, CatalogSource,
    CatalogWorker, Error, WorkerError,
};
use crate::tmux_handoff::ServerScope;
use std::collections::{BTreeSet, VecDeque};
/// Hard ceiling for a caller-expanded fleet observation; concurrency remains four.
pub const MAX_AGENT_OBSERVATION_SESSIONS: usize = 512;
const MAX_READS: usize = 4;

pub struct AgentObservationRequest {
    /// Private caller key, not session selection authority.
    pub key: String,
    pub catalog_identity: super::CatalogIdentity,
    pub source: CatalogSource,
    pub scope: ServerScope,
    pub live_session_id: String,
    pub workspace_name: String,
}
#[derive(Debug, thiserror::Error)]
pub enum AgentObservationError {
    #[error("agent observation could not be read")]
    Read(#[source] Error),
    #[error("agent observation worker failed")]
    Worker(#[source] WorkerError),
}
#[derive(Debug, thiserror::Error)]
pub enum AgentObservationPoolError {
    #[error("agent observation requests are invalid, duplicated or exceed the session limit")]
    Requests,
}
pub struct AgentObservationEvent {
    pub epoch: uuid::Uuid,
    pub key: String,
    pub result: Result<AgentObservation, AgentObservationError>,
}
struct Running {
    epoch: uuid::Uuid,
    request: AgentObservationRequest,
    worker: CatalogWorker,
}
#[derive(Default)]
pub struct AgentObservationPool {
    epoch: Option<uuid::Uuid>,
    queue: VecDeque<AgentObservationRequest>,
    active: Vec<Running>,
    retiring: Vec<CatalogRetirement>,
}
impl AgentObservationPool {
    /// Replace one observation batch. Old reads lose publication rights at once,
    /// but still occupy a slot until their exact worker has finished.
    pub fn replace(
        &mut self,
        requests: Vec<AgentObservationRequest>,
    ) -> Result<uuid::Uuid, AgentObservationPoolError> {
        let mut keys = BTreeSet::new();
        if requests.len() > MAX_AGENT_OBSERVATION_SESSIONS
            || requests.iter().any(|r| {
                r.key.is_empty()
                    || r.key.len() > 512
                    || !keys.insert(&r.key)
                    || !super::agent_observation::valid_target(
                        &r.live_session_id,
                        &r.workspace_name,
                    )
            })
        {
            return Err(AgentObservationPoolError::Requests);
        }
        self.cancel();
        let epoch = uuid::Uuid::new_v4();
        self.epoch = Some(epoch);
        self.queue = requests.into();
        Ok(epoch)
    }
    pub fn cancel(&mut self) {
        self.epoch = None;
        self.queue.clear();
        for run in self.active.drain(..) {
            self.retiring.push(run.worker.retire());
        }
        self.reap();
    }
    fn reap(&mut self) {
        self.retiring.retain(|worker| !worker.is_finished());
    }
    pub fn busy(&self) -> bool {
        !self.queue.is_empty() || !self.active.is_empty() || !self.retiring.is_empty()
    }
    pub fn poll(&mut self) -> Vec<AgentObservationEvent> {
        self.reap();
        let mut events = Vec::new();
        let mut index = 0;
        while index < self.active.len() {
            let result = match self.active[index].worker.poll() {
                Ok(None) => {
                    index += 1;
                    continue;
                }
                Ok(Some(result)) => result
                    .map_err(AgentObservationError::Read)
                    .and_then(|value| match value {
                        CatalogResult::AgentObservation(value) => Ok(value),
                        _ => Err(AgentObservationError::Read(Error::ResourceFormat)),
                    }),
                Err(error) => Err(AgentObservationError::Worker(error)),
            };
            let run = self.active.remove(index);
            self.retiring.push(run.worker.retire());
            if self.epoch == Some(run.epoch) {
                let result = result.and_then(|value| {
                    if value.scope != run.request.scope
                        || value.live_session_id != run.request.live_session_id
                        || value.workspace_name != run.request.workspace_name
                    {
                        Err(AgentObservationError::Read(Error::ServerChanged))
                    } else {
                        Ok(value)
                    }
                });
                events.push(AgentObservationEvent {
                    epoch: run.epoch,
                    key: run.request.key,
                    result,
                });
            }
        }
        self.reap();
        while self.active.len() + self.retiring.len() < MAX_READS {
            let Some(request) = self.queue.pop_front() else {
                break;
            };
            let Some(epoch) = self.epoch else { break };
            match CatalogWorker::spawn_source(request.source.clone()) {
                Ok(mut worker) => {
                    let action = CatalogAction::ObserveAgents {
                        expected_catalog: Some(request.catalog_identity.clone()),
                        scope: request.scope.clone(),
                        live_session_id: request.live_session_id.clone(),
                        workspace_name: request.workspace_name.clone(),
                    };
                    match worker.submit(action) {
                        Ok(()) => self.active.push(Running {
                            epoch,
                            request,
                            worker,
                        }),
                        Err(error) => {
                            self.retiring.push(worker.retire());
                            events.push(AgentObservationEvent {
                                epoch,
                                key: request.key,
                                result: Err(AgentObservationError::Worker(error)),
                            });
                        }
                    }
                }
                Err(error) => events.push(AgentObservationEvent {
                    epoch,
                    key: request.key,
                    result: Err(AgentObservationError::Worker(error)),
                }),
            }
        }
        events
    }
}
impl Drop for AgentObservationPool {
    fn drop(&mut self) {
        self.cancel();
    }
}
#[cfg(all(test, unix))]
#[path = "agent_observation_pool_tests.rs"]
mod tests;
