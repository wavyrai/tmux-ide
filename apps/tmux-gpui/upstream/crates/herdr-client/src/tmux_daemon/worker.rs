//! Bounded background owner operations for the native browser. Cancellation
//! discards replies and queued work; it cannot undo an already-sent mutation.
use super::{
    CatalogSource, CreatedSession, Error, ServerClient, ServerRegistration, Session,
    TerminalSelection,
};
use crate::tmux_handoff::{Handoff, ServerScope};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};
use uuid::Uuid;

pub enum CatalogAction {
    OpenObservedAgent {
        scope: ServerScope,
        selection: Box<super::AgentSelection>,
    },
    ObserveAgents {
        expected_catalog: Option<super::CatalogIdentity>,
        scope: ServerScope,
        live_session_id: String,
        workspace_name: String,
    },
    ProveLocalSession,
    LocalSessionCatalog {
        proof: super::LocalSessionProof,
    },
    CreateLocalSession {
        proof: super::LocalSessionProof,
        operation_id: Uuid,
        display_name: String,
    },
    VerifyLocalSessionOwner {
        proof: super::LocalSessionProof,
    },
    FleetCatalog,
    Catalog,
    FleetPreferences {
        change: Option<(super::LocalOwnerStamp, super::FleetPreferenceChange)>,
    },
    PrepareMachine {
        target: String,
    },
    SavedMachines,
    MutateMachine {
        expected: super::SavedMachineRegistry,
        change: super::MachineChange,
    },
    CreatePane {
        scope: ServerScope,
        operation_id: Uuid,
        creation: super::PaneCreation,
    },
    OpenEditor {
        scope: ServerScope,
        target: super::EditorTarget,
    },
    EditorContext {
        scope: ServerScope,
        target: super::EditorTarget,
    },
    Servers,
    History {
        scope: ServerScope,
        request: crate::tmux_history::AnchorRequest,
    },
    SplitLayout {
        scope: ServerScope,
        workspace: String,
        window: crate::tmux_control::WindowLink,
    },
    Sessions {
        scope: ServerScope,
    },
    Open {
        scope: ServerScope,
        live_session_id: String,
    },
    Create {
        scope: ServerScope,
        operation_id: Uuid,
        display_name: String,
    },
    Issue {
        scope: ServerScope,
        selection: TerminalSelection,
    },
}
pub enum CatalogResult {
    AgentOpened(super::OpenedAgent),
    AgentObservation(super::AgentObservation),
    LocalSessionProof(super::LocalSessionProof),
    LocalSessionOwnerVerified,
    FleetCatalog(super::FleetCatalog),
    Catalog(super::CatalogSnapshot),
    FleetPreferences {
        state: super::FleetClientState,
        owner: super::LocalOwnerStamp,
    },
    MachinePrepared(super::PreparedMachine),
    SavedMachines(super::SavedMachineRegistry),
    PaneCreated(super::CreatedPane),
    EditorOpened,
    EditorContext(super::EditorContext),
    Servers(Vec<ServerRegistration>),
    History(Option<crate::tmux_history::AnchorResult>),
    SplitLayout(crate::tmux_control::SplitLayout),
    Sessions(Vec<Session>),
    Opened {
        workspace_name: String,
        panes: Vec<String>,
    },
    Created(CreatedSession),
    Issued(Box<Handoff>),
}
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("native catalog worker is busy")]
    Busy,
    #[error("native catalog worker is closed")]
    Closed,
    #[error("native catalog worker could not start")]
    Spawn(#[source] std::io::Error),
}
struct Job {
    action: CatalogAction,
    cancelled: Arc<AtomicBool>,
}
struct Reply {
    cancelled: Arc<AtomicBool>,
    result: Result<CatalogResult, Error>,
}
type Mailbox = Arc<Mutex<Option<Reply>>>;
/// One outstanding operation. Poll on the UI thread; all discovery and HTTP IO
/// run on the owned worker. Drop invalidates work without joining that thread.
pub struct CatalogWorker {
    commands: mpsc::SyncSender<Job>,
    mailbox: Mailbox,
    pending: Option<Arc<AtomicBool>>,
    closed: Arc<AtomicBool>,
    reset_requested: Arc<AtomicBool>,
}
/// Completion of a canceled worker, without blocking or joining the caller.
/// Resource pools retain this receipt before admitting replacement work.
pub struct CatalogRetirement(Arc<AtomicBool>);
struct WorkerCompletion(Arc<AtomicBool>);
impl Drop for WorkerCompletion {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
impl CatalogRetirement {
    pub fn is_finished(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
impl CatalogWorker {
    pub fn retire(self) -> CatalogRetirement {
        let receipt = CatalogRetirement(Arc::clone(&self.closed));
        drop(self);
        receipt
    }

    pub fn spawn(record: PathBuf) -> Result<Self, WorkerError> {
        Self::spawn_source(CatalogSource::Local(record))
    }
    #[cfg(unix)]
    pub fn spawn_remote(
        target: crate::tmux_ssh::SshTarget,
        expected_environment: Option<String>,
    ) -> Result<Self, WorkerError> {
        Self::spawn_source(CatalogSource::remote(target, expected_environment))
    }
    pub fn spawn_source(source: CatalogSource) -> Result<Self, WorkerError> {
        let (commands, receiver) = mpsc::sync_channel::<Job>(1);
        let mailbox: Mailbox = Arc::new(Mutex::new(None));
        let output = Arc::clone(&mailbox);
        let closed = Arc::new(AtomicBool::new(false));
        let finished = Arc::clone(&closed);
        let reset_requested = Arc::new(AtomicBool::new(false));
        let reset = Arc::clone(&reset_requested);
        std::thread::Builder::new()
            .name("tmux-catalog".into())
            .spawn(move || {
                let _finished = WorkerCompletion(finished);
                // Discovery is lazy so dropping an unused worker does no IO.
                let mut daemon = None;
                let mut selected: Option<ServerClient> = None;
                while let Ok(job) = receiver.recv() {
                    if job.cancelled.load(Ordering::Acquire) {
                        continue;
                    }
                    let reset_result = if reset.swap(false, Ordering::AcqRel) {
                        if let Some(old) = selected.take() {
                            old.retire();
                        }
                        let result = source.reset(daemon.as_ref());
                        daemon = None;
                        result
                    } else {
                        Ok(())
                    };
                    let result = (|| {
                        reset_result?;
                        if daemon.is_none() {
                            daemon = Some(source.discover(&job.cancelled)?);
                        }
                        let Some(daemon) = daemon.as_ref() else {
                            return Err(Error::Retired);
                        };
                        if job.cancelled.load(Ordering::Acquire) {
                            return Err(Error::Retired);
                        }
                        execute(daemon, &mut selected, job.action, &job.cancelled)
                    })();
                    if let Ok(mut slot) = output.lock() {
                        // Check under the same lock cancellation uses to clear the
                        // mailbox, so a stale reply cannot race back into it.
                        if !job.cancelled.load(Ordering::Acquire) {
                            *slot = Some(Reply {
                                cancelled: job.cancelled,
                                result,
                            });
                        }
                    } else {
                        break;
                    }
                }
                if let Some(client) = selected {
                    client.retire();
                }
            })
            .map_err(WorkerError::Spawn)?;
        Ok(Self {
            commands,
            mailbox,
            pending: None,
            closed,
            reset_requested,
        })
    }
    pub fn submit(&mut self, action: CatalogAction) -> Result<(), WorkerError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(WorkerError::Closed);
        }
        if self.pending.is_some() {
            return Err(WorkerError::Busy);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.commands
            .try_send(Job {
                action,
                cancelled: Arc::clone(&cancelled),
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => WorkerError::Busy,
                mpsc::TrySendError::Disconnected(_) => WorkerError::Closed,
            })?;
        self.pending = Some(cancelled);
        Ok(())
    }
    pub fn poll(&mut self) -> Result<Option<Result<CatalogResult, Error>>, WorkerError> {
        let mut slot = self.mailbox.lock().map_err(|_| WorkerError::Closed)?;
        if let Some(reply) = slot.take()
            && self
                .pending
                .as_ref()
                .is_some_and(|p| Arc::ptr_eq(p, &reply.cancelled))
            && !reply.cancelled.load(Ordering::Acquire)
        {
            self.pending = None;
            return Ok(Some(reply.result));
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(WorkerError::Closed);
        }
        Ok(None)
    }
    /// Explicitly rediscover the owner on the next job, on the same bounded
    /// worker. Existing IO may finish, but cannot publish or replay after reset.
    pub fn reset(&mut self) {
        self.cancel();
        self.reset_requested.store(true, Ordering::Release);
    }
    /// A cancelled mutation may already have committed. Retain its operation ID
    /// and explicitly reconcile; this worker never retries or replays it.
    pub fn cancel(&mut self) {
        if let Some(pending) = self.pending.take() {
            pending.store(true, Ordering::Release);
        }
        if let Ok(mut slot) = self.mailbox.lock() {
            *slot = None;
        }
    }
}
impl Drop for CatalogWorker {
    fn drop(&mut self) {
        self.cancel();
    }
}
fn execute(
    daemon: &super::owner::Owner,
    selected: &mut Option<ServerClient>,
    action: CatalogAction,
    cancelled: &Arc<AtomicBool>,
) -> Result<CatalogResult, Error> {
    if let CatalogAction::ObserveAgents {
        expected_catalog: Some(expected),
        ..
    } = &action
        && &daemon.catalog_identity() != expected
    {
        return Err(Error::IdentityChanged);
    }
    let scope = match &action {
        CatalogAction::LocalSessionCatalog { proof } => {
            let local = daemon.local()?;
            local.verify_local_session_owner(proof)?;
            let catalog = daemon.fleet_catalog(cancelled)?;
            local.verify_local_session_owner(proof)?;
            return Ok(CatalogResult::FleetCatalog(catalog));
        }
        CatalogAction::ProveLocalSession => {
            return daemon
                .local()?
                .prove_local_session_create(cancelled)
                .map(CatalogResult::LocalSessionProof);
        }
        CatalogAction::CreateLocalSession {
            proof,
            operation_id,
            display_name,
        } => {
            return daemon
                .local()?
                .create_local_session(proof, *operation_id, display_name, cancelled)
                .map(CatalogResult::Created);
        }
        CatalogAction::VerifyLocalSessionOwner { proof } => {
            daemon.local()?.verify_local_session_owner(proof)?;
            return Ok(CatalogResult::LocalSessionOwnerVerified);
        }
        CatalogAction::FleetCatalog => {
            return daemon
                .fleet_catalog(cancelled)
                .map(CatalogResult::FleetCatalog);
        }
        CatalogAction::Catalog => return daemon.catalog().map(CatalogResult::Catalog),
        CatalogAction::Servers => return daemon.list_servers().map(CatalogResult::Servers),
        CatalogAction::FleetPreferences { change } => {
            let owner = daemon.local()?;
            return match change {
                Some((expected, change)) => {
                    if owner.owner_stamp() != *expected {
                        return Err(Error::RecordChanged);
                    }
                    owner.change_fleet_preference(change, cancelled)
                }
                None => owner.fleet_preferences(),
            }
            .map(|state| CatalogResult::FleetPreferences {
                state,
                owner: owner.owner_stamp(),
            });
        }
        CatalogAction::PrepareMachine { target } => {
            return daemon
                .local()?
                .prepare_machine_connection(target, cancelled)
                .map(CatalogResult::MachinePrepared);
        }
        CatalogAction::SavedMachines => {
            return daemon
                .local()?
                .saved_machines()
                .map(CatalogResult::SavedMachines);
        }
        CatalogAction::MutateMachine { expected, change } => {
            return daemon
                .local()?
                .mutate_saved_machine(expected, change)
                .map(CatalogResult::SavedMachines);
        }
        CatalogAction::OpenObservedAgent { scope, .. }
        | CatalogAction::ObserveAgents { scope, .. }
        | CatalogAction::CreatePane { scope, .. }
        | CatalogAction::OpenEditor { scope, .. }
        | CatalogAction::EditorContext { scope, .. }
        | CatalogAction::Sessions { scope }
        | CatalogAction::Open { scope, .. }
        | CatalogAction::Create { scope, .. }
        | CatalogAction::Issue { scope, .. }
        | CatalogAction::SplitLayout { scope, .. }
        | CatalogAction::History { scope, .. } => scope,
    };
    if selected
        .as_ref()
        .is_none_or(|client| client.scope() != scope)
    {
        if let Some(old) = selected.take() {
            old.retire();
        }
        *selected = Some(daemon.select_server(scope)?);
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(Error::Retired);
    }
    let Some(client) = selected.as_mut() else {
        return Err(Error::Retired);
    };
    client.bind_request(Arc::clone(cancelled));
    match action {
        CatalogAction::OpenObservedAgent { selection, .. } => client
            .open_observed_agent(&selection)
            .map(CatalogResult::AgentOpened),
        CatalogAction::ObserveAgents {
            live_session_id,
            workspace_name,
            ..
        } => client
            .observe_agents(&live_session_id, &workspace_name)
            .map(CatalogResult::AgentObservation),
        CatalogAction::ProveLocalSession
        | CatalogAction::LocalSessionCatalog { .. }
        | CatalogAction::CreateLocalSession { .. }
        | CatalogAction::VerifyLocalSessionOwner { .. }
        | CatalogAction::Servers
        | CatalogAction::Catalog
        | CatalogAction::FleetCatalog
        | CatalogAction::FleetPreferences { .. }
        | CatalogAction::PrepareMachine { .. }
        | CatalogAction::SavedMachines
        | CatalogAction::MutateMachine { .. } => unreachable!(),
        CatalogAction::CreatePane {
            operation_id,
            creation,
            ..
        } => {
            let receipt = client.create_pane(operation_id, &creation)?;
            client
                .await_created_pane(
                    &creation.live_session_id,
                    &creation.workspace_name,
                    &receipt.resource.semantic_pane_id,
                )
                .map_err(|source| Error::ActionUncertain {
                    operation_id,
                    source: Box::new(source),
                })?;
            Ok(CatalogResult::PaneCreated(receipt))
        }
        CatalogAction::OpenEditor { target, .. } => client
            .open_editor(&target)
            .map(|()| CatalogResult::EditorOpened),
        CatalogAction::EditorContext { target, .. } => client
            .editor_context(&target)
            .map(CatalogResult::EditorContext),
        CatalogAction::History { request, .. } => {
            client.history_anchor(&request).map(CatalogResult::History)
        }
        CatalogAction::SplitLayout {
            workspace, window, ..
        } => client
            .split_layout(&workspace, &window)
            .map(CatalogResult::SplitLayout),
        CatalogAction::Sessions { .. } => client.sessions().map(CatalogResult::Sessions),
        CatalogAction::Open {
            live_session_id, ..
        } => {
            let workspace_name = client.open_session(&live_session_id)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(Error::Retired);
            }
            let panes = client.workspace_panes(&live_session_id, &workspace_name)?;
            Ok(CatalogResult::Opened {
                workspace_name,
                panes,
            })
        }
        CatalogAction::Create {
            operation_id,
            display_name,
            ..
        } => client
            .create_session(operation_id, &display_name)
            .map(CatalogResult::Created),
        CatalogAction::Issue { selection, .. } => client
            .issue_terminal(&selection)
            .map(|handoff| CatalogResult::Issued(Box::new(handoff))),
    }
}

#[cfg(all(test, unix))]
#[path = "worker_preferences_tests.rs"]
mod preferences_tests;
