//! Local native catalog owner. No helper process, pipe codec or owner token enters
//! the terminal/UI loop. Development entry until remaining actions are migrated.
use super::*;
use herdr_client::{
    tmux_daemon::{
        CatalogAction, CatalogResult, CatalogSource, CatalogWorker, ServerRegistration,
        TerminalSelection, WorkerError,
    },
    tmux_handoff::ServerScope,
    tmux_stream::ViewerMode,
};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone)]
struct Target {
    scope: ServerScope,
    live: String,
}
struct Route {
    id: String,
    request: u64,
    target: Target,
    workspace: String,
}
#[path = "browser_native_local_agents.rs"]
mod agents;
#[path = "browser_native_local_fleet.rs"]
mod background_fleet;
#[path = "browser_native_local_browser.rs"]
mod browser_controls;
#[path = "browser_native_local_catalog.rs"]
mod catalog;
#[path = "browser_native_local_commands.rs"]
mod commands;
#[path = "browser_native_local_editor.rs"]
mod editor;
#[path = "browser_native_local_creation.rs"]
mod local_creation;
#[path = "browser_native_local_navigation.rs"]
mod navigation;
#[path = "browser_native_local_owner.rs"]
mod owner;
#[path = "browser_native_local_preferences.rs"]
mod preferences;
#[path = "browser_native_local_reconnect.rs"]
mod reconnect;
#[path = "browser_native_local_machines.rs"]
mod registry;
#[path = "browser_native_local_routes.rs"]
mod routes;
#[path = "browser_native_local_topology.rs"]
mod topology;
#[path = "browser_native_local_watch.rs"]
mod watch;
pub(in crate::tmux_snapshot) use routes::Owner as NativeOwner;
#[path = "browser_native_local_split.rs"]
mod split;
enum Stage {
    AgentOpen {
        target: Target,
        selection: Box<herdr_client::tmux_daemon::AgentSelection>,
    },
    LocalProve,
    LocalCreate {
        proof: herdr_client::tmux_daemon::LocalSessionProof,
        operation_id: uuid::Uuid,
        name: String,
    },
    LocalCatalog {
        proof: herdr_client::tmux_daemon::LocalSessionProof,
        receipt: herdr_client::tmux_daemon::CreatedSession,
    },
    Preferences {
        change: Option<(
            herdr_client::tmux_daemon::LocalOwnerStamp,
            herdr_client::tmux_daemon::FleetPreferenceChange,
        )>,
    },
    AddMachine {
        target: String,
    },
    VerifyProfile,
    MachineSelection {
        expected: herdr_client::tmux_daemon::SavedMachineRegistry,
        id: String,
    },
    Machines {
        change: Option<(
            herdr_client::tmux_daemon::SavedMachineRegistry,
            herdr_client::tmux_daemon::MachineChange,
        )>,
    },
    Owner {
        scope: ServerScope,
        operation_id: uuid::Uuid,
        creation: herdr_client::tmux_daemon::PaneCreation,
        request: browser_native_owner::Request,
    },
    Editor {
        scope: ServerScope,
        target: herdr_client::tmux_daemon::EditorTarget,
        request: super::super::super::browser_native_editor::Request,
    },
    History {
        scope: ServerScope,
        id: String,
        request: u64,
        operation_id: u64,
        body: herdr_client::tmux_history::AnchorRequest,
    },
    Create {
        scope: ServerScope,
        operation_id: uuid::Uuid,
        name: String,
    },
    Servers,
    Open {
        target: Target,
        preferred: Option<String>,
    },
    Issue {
        target: Target,
        workspace: String,
        panes: Vec<String>,
        selected: String,
    },
}
impl Stage {
    fn local_owner(&self) -> bool {
        self.registry()
            || matches!(
                self,
                Self::Preferences { .. }
                    | Self::LocalProve
                    | Self::LocalCreate { .. }
                    | Self::LocalCatalog { .. }
            )
    }
    fn registry(&self) -> bool {
        matches!(
            self,
            Self::Machines { .. }
                | Self::MachineSelection { .. }
                | Self::VerifyProfile
                | Self::AddMachine { .. }
        )
    }
    fn action(&self) -> CatalogAction {
        match self {
            Self::AgentOpen { target, selection } => CatalogAction::OpenObservedAgent {
                scope: target.scope.clone(),
                selection: selection.clone(),
            },
            Self::LocalProve => CatalogAction::ProveLocalSession,
            Self::LocalCreate {
                proof,
                operation_id,
                name,
            } => CatalogAction::CreateLocalSession {
                proof: proof.clone(),
                operation_id: *operation_id,
                display_name: name.clone(),
            },
            Self::LocalCatalog { proof, .. } => CatalogAction::LocalSessionCatalog {
                proof: proof.clone(),
            },
            Self::Preferences { change } => CatalogAction::FleetPreferences {
                change: change.clone(),
            },
            Self::AddMachine { target } => CatalogAction::PrepareMachine {
                target: target.clone(),
            },
            Self::MachineSelection { .. } | Self::VerifyProfile => CatalogAction::SavedMachines,
            Self::Machines { change: None } => CatalogAction::SavedMachines,
            Self::Machines {
                change: Some((expected, change)),
            } => CatalogAction::MutateMachine {
                expected: expected.clone(),
                change: change.clone(),
            },
            Self::Owner {
                scope,
                operation_id,
                creation,
                ..
            } => CatalogAction::CreatePane {
                scope: scope.clone(),
                operation_id: *operation_id,
                creation: creation.clone(),
            },
            Self::Editor { scope, target, .. } => CatalogAction::OpenEditor {
                scope: scope.clone(),
                target: target.clone(),
            },
            Self::Servers => CatalogAction::FleetCatalog,
            Self::Create {
                scope,
                operation_id,
                name,
            } => CatalogAction::Create {
                scope: scope.clone(),
                operation_id: *operation_id,
                display_name: name.clone(),
            },
            Self::History { scope, body, .. } => CatalogAction::History {
                scope: scope.clone(),
                request: body.clone(),
            },
            Self::Open { target, .. } => CatalogAction::Open {
                scope: target.scope.clone(),
                live_session_id: target.live.clone(),
            },
            Self::Issue {
                target,
                workspace,
                panes,
                selected,
            } => CatalogAction::Issue {
                scope: target.scope.clone(),
                selection: TerminalSelection {
                    workspace_name: workspace.clone(),
                    live_session_id: target.live.clone(),
                    selected_pane: selected.clone(),
                    visible_panes: panes.clone(),
                    mode: ViewerMode::Interactive,
                },
            },
        }
    }
}
struct Local {
    machine_id: String,
    machine_label: String,
    catalog_identity: Option<herdr_client::tmux_daemon::CatalogIdentity>,
    worker: CatalogWorker,
    events: mpsc::SyncSender<Incoming>,
    state: State,
    targets: BTreeMap<String, Target>,
    stage: Option<Stage>,
    submitted: bool,
    active: Option<Route>,
    split: split::Reader,
    foreground: bool,
    presence_revision: u64,
    editor: editor::Gate,
    browser_controls: browser_controls::Gate,
    owner: owner::Gate,
    uncertain_create: Option<uuid::Uuid>,
    local_creation: local_creation::Gate,
    agents: agents::Gate,
    appearance: Option<crate::tmux_snapshot::appearance::native::Owner>,
    recovery: Option<reconnect::Recovery>,
    background_fleet: background_fleet::Gate,
    registry: registry::Gate,
    preferences: preferences::Gate,
    navigation: navigation::Ledger,
    registry_worker: Option<CatalogWorker>,
    registry_dirty: bool,
    local_record: Option<PathBuf>,
    sources: NativeOwner,
    selected_profile: Option<herdr_client::tmux_daemon::SavedMachine>,
}
pub(in crate::tmux_snapshot) fn start(
    record: PathBuf,
    kitty: crate::tmux_snapshot::kitty_graphics::Store,
) -> Result<(Bridge, NativeOwner), Error> {
    start_source(
        CatalogSource::Local(record.clone()),
        Some(record),
        "local".into(),
        "Local".into(),
        kitty,
    )
}
#[cfg(unix)]
pub(in crate::tmux_snapshot) fn start_remote(
    target: herdr_client::tmux_ssh::SshTarget,
    expected_environment: Option<String>,
    local_record: Option<PathBuf>,
    kitty: crate::tmux_snapshot::kitty_graphics::Store,
) -> Result<(Bridge, NativeOwner), Error> {
    let label = target.as_str().chars().take(160).collect();
    let source = CatalogSource::remote(target, expected_environment);
    start_source(source, local_record, "native-ssh".into(), label, kitty)
}
fn start_source(
    source: CatalogSource,
    local_record: Option<PathBuf>,
    machine_id: String,
    machine_label: String,
    kitty: crate::tmux_snapshot::kitty_graphics::Store,
) -> Result<(Bridge, NativeOwner), Error> {
    let worker = CatalogWorker::spawn_source(source.clone())?;

    let (events, receiver) = mpsc::sync_channel(8);
    let (commands, input) = mpsc::sync_channel(32);
    let sources = NativeOwner::new(source.clone());
    let registry_worker = local_record
        .as_ref()
        .map(|record| CatalogWorker::spawn(record.clone()))
        .transpose()?;
    let split = split::Reader::from_source(source)?;
    let local = Local {
        machine_id,
        machine_label,
        catalog_identity: None,
        worker,
        events,
        state: State {
            home_phase: HomePhase::Loading,
            status: "Loading sessions".into(),
            ..State::default()
        },
        targets: BTreeMap::new(),
        stage: Some(Stage::Servers),
        submitted: false,
        active: None,
        split,
        foreground: true,
        presence_revision: 0,
        editor: Default::default(),
        browser_controls: Default::default(),
        owner: Default::default(),
        uncertain_create: None,
        local_creation: Default::default(),
        agents: Default::default(),
        appearance: None,
        recovery: None,
        background_fleet: Default::default(),
        registry: Default::default(),
        preferences: Default::default(),
        navigation: Default::default(),
        registry_worker,
        registry_dirty: false,
        local_record,
        sources: sources.clone(),
        selected_profile: None,
    };
    let cleanup = sources.clone();
    let actor = std::thread::Builder::new()
        .name("tmux-native-browser".into())
        .spawn(move || {
            if local.run(input).is_err() {
                eprintln!("tmux-ide: native catalog closed");
            }
            let _ = cleanup.shutdown();
        })?;
    let commands = watch::Commands::new(commands, actor.thread().clone());
    Ok((
        start_events(kitty, receiver, move || {
            move |command| commands.send(command)
        }),
        sources,
    ))
}
impl Local {
    fn emit(&self, event: Incoming) -> Result<(), Error> {
        self.events
            .try_send(event)
            .map_err(|_| Error::Invalid("native catalog event queue closed or full"))
    }
    fn publish(&mut self) -> Result<(), Error> {
        let mut state = self.state.clone();
        // Home has no terminal stream to acknowledge focus. Once a route is
        // open, its controller remains the authority for presence admission.
        if self.active.is_none() {
            state.presence_revision = self.presence_revision;
        }
        self.refresh_workspace_agent_selection(&mut state);
        let picker_ready = self.catalog_identity.is_some()
            && ((state.surface == Surface::Home && state.home_phase == HomePhase::Live)
                || (state.surface == Surface::Workspace && self.active.is_some()));
        state.palette_supported = picker_ready;
        state.attention_supported = picker_ready;
        if let Some(owner) = &self.appearance {
            state.appearance = Some(owner.publication());
        }
        self.background_fleet.project(
            &mut state,
            &self.machine_id,
            self.catalog_identity.as_ref(),
        )?;
        self.agents.publish_filter(&mut state);
        self.published_preferences(&mut state);
        state.machines = Some(self.registry.publication());
        self.publish_tabs(&mut state);
        state.session_history = self.navigation.publication(state.request, self.foreground);
        self.emit(Incoming::Catalog(Box::new(state)))
    }
    fn close(&mut self) -> Result<(), Error> {
        self.preferences.visits.detach();
        self.navigation.cancel();
        self.editor = Default::default();
        self.browser_controls = Default::default();
        self.state.browser_controls.clear();
        self.owner = Default::default();
        self.split.cancel();
        if let Some(Route { id, request, .. }) = self.active.take() {
            self.emit(Incoming::Handoff(Event::Close {
                version: 1,
                id,
                request,
            }))?;
        }
        Ok(())
    }
    fn cancel(&mut self) -> Result<(), Error> {
        self.recovery = None;
        self.cancel_local_creation();
        self.agents.cancel();
        self.state.home_agents = None;
        self.state.workspace_agents = None;
        self.state.workspace_fleet_agents = None;
        self.state.workspace_fleet_agent_rejected = None;
        self.state.palette_agents = None;
        self.state.attention_agents = None;
        self.state.palette_selection_rejected = None;
        self.state.attention_selection_rejected = None;
        self.sources.cancel_catalog_read()?;
        self.sources.cancel_setup()?;
        self.fleet_cancel_control();
        self.cancel_preferences()?;
        self.cancel_registry();
        if self.submitted
            && let Some(Stage::Create { operation_id, .. }) = &self.stage
        {
            self.uncertain_create = Some(*operation_id);
        }
        self.worker.cancel();
        self.stage = None;
        self.submitted = false;
        self.close()
    }
    fn unavailable(&mut self, status: &'static str) -> Result<(), Error> {
        self.cancel()?;
        self.state = State {
            request: self.state.request,
            home_phase: HomePhase::Unavailable,
            status: status.into(),
            ..State::default()
        };
        self.publish()
    }
    fn home(&mut self, request: u64) -> Result<(), Error> {
        self.background_fleet.refresh();
        self.begin_home(request, false)
    }
    fn begin_home(&mut self, request: u64, profile_verified: bool) -> Result<(), Error> {
        self.cancel()?;
        self.sources.reset_catalog()?;
        // Explicit refresh may discover a replacement owner; an existing request
        // never crosses that identity boundary or replays into the new owner.
        self.worker.reset();
        self.split.reset();
        self.targets.clear();
        self.catalog_identity = None;
        self.preferences.refresh();
        self.state = State {
            request,
            home_phase: HomePhase::Loading,
            status: "Loading sessions".into(),
            ..State::default()
        };
        self.stage = Some(if self.selected_profile.is_some() && !profile_verified {
            self.registry.begin();
            Stage::VerifyProfile
        } else {
            Stage::Servers
        });
        self.publish()
    }
    fn open(&mut self, request: u64, key: String, preferred: Option<String>) -> Result<(), Error> {
        if !self.background_fleet.allows_current() {
            return Ok(());
        }
        let Some(target) = self.targets.get(&key).cloned() else {
            return Ok(());
        };
        self.cancel()?;
        self.state.request = request;
        self.state.surface = Surface::Workspace;
        self.state.sessions = self
            .state
            .sessions
            .iter()
            .filter_map(|choice| {
                let entry = self.targets.get(&choice.id)?;
                if entry.scope != target.scope {
                    return None;
                }
                let mut choice = choice.clone();
                choice.id = entry.live.clone();
                Some(choice)
            })
            .collect();
        let aliases: Vec<_> = self
            .targets
            .values()
            .filter(|entry| entry.scope == target.scope)
            .cloned()
            .collect();
        for entry in aliases {
            self.targets.insert(entry.live.clone(), entry);
        }
        self.state.selected_session = Some(target.live.clone());
        self.state.selected_pane = None;
        self.state.panes.clear();
        self.state.status = "Opening terminal".into();
        self.stage = Some(Stage::Open { target, preferred });
        self.publish()
    }
    fn run(mut self, input: mpsc::Receiver<Command>) -> Result<(), Error> {
        self.appearance = crate::tmux_snapshot::appearance::native::Owner::from_environment(
            self.local_record.clone(),
        );
        self.state.appearance = self.appearance.as_ref().map(|owner| owner.publication());
        self.sources.start_watch(self.local_record.clone())?;
        self.publish()?;
        loop {
            loop {
                match input.try_recv() {
                    Ok(command) => self.command(command)?,
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => return self.cancel(),
                }
            }
            if self.browser_controls_tick().is_err() {
                // Optional browser chrome must never tear down terminal delivery.
                self.browser_controls = Default::default();
                self.state.browser_controls.clear();
                self.publish()?;
            }
            self.setup_tick()?;
            self.watch_tick()?;
            self.fleet_tick()?;
            self.selected_catalog_tick()?;
            self.reconnect_tick()?;
            if !self.submitted
                && let Some(stage) = &self.stage
            {
                // Do not create an interactive lease while backgrounded.
                if self.foreground || !matches!(stage, Stage::Issue { .. }) {
                    let action = stage.action();
                    let worker = if stage.local_owner() {
                        self.registry_worker.as_mut()
                    } else {
                        Some(&mut self.worker)
                    };
                    let Some(worker) = worker else {
                        let selecting = matches!(
                            stage,
                            Stage::AddMachine { .. } | Stage::MachineSelection { .. }
                        );
                        self.stage = None;
                        self.registry.finish(Err(
                            herdr_client::tmux_daemon::Error::LocalAuthorityRequired,
                        ));
                        if selecting {
                            self.unavailable("Saved machines require a local daemon record")?;
                        } else {
                            self.publish()?;
                        }
                        continue;
                    };
                    match worker.submit(action) {
                        Ok(()) => self.submitted = true,
                        Err(WorkerError::Busy) => {}
                        Err(error) => return Err(error.into()),
                    }
                }
            }
            let result = if self.stage.as_ref().is_some_and(Stage::local_owner) {
                self.registry_worker
                    .as_mut()
                    .map(CatalogWorker::poll)
                    .transpose()?
                    .flatten()
            } else {
                self.worker.poll()?
            };
            if let Some(result) = result {
                self.submitted = false;
                if let Some(stage) = self.stage.take() {
                    match result {
                        Ok(result) => self.completed(stage, result)?,
                        Err(error)
                            if matches!(
                                stage,
                                Stage::LocalProve
                                    | Stage::LocalCreate { .. }
                                    | Stage::LocalCatalog { .. }
                            ) =>
                        {
                            self.local_creation_failed(stage, error)?
                        }
                        Err(_) if matches!(stage, Stage::Preferences { .. }) => {
                            self.preference_failed()?
                        }
                        Err(error) if stage.registry() => {
                            let selecting = matches!(
                                stage,
                                Stage::MachineSelection { .. } | Stage::AddMachine { .. }
                            );
                            self.registry_failed(error)?;
                            if selecting {
                                self.unavailable("Saved machine verification failed — refresh and select it again")?;
                            }
                        }
                        Err(_) if matches!(stage, Stage::Owner { .. }) => {
                            if let Stage::Owner { request, .. } = stage {
                                self.owner_completed(request, None)?;
                            }
                        }
                        Err(error) if matches!(stage, Stage::Editor { .. }) => {
                            if let Stage::Editor { request, .. } = stage {
                                self.editor_completed(request, Err(error))?;
                            }
                        }
                        Err(error) if matches!(stage, Stage::History { .. }) => {
                            if let Stage::History {
                                id,
                                request,
                                operation_id,
                                ..
                            } = stage
                            {
                                self.emit(Incoming::History(Response::from_native(
                                    id,
                                    request,
                                    operation_id,
                                    Err(error),
                                )))?;
                            }
                        }
                        Err(error) if matches!(stage, Stage::Create { .. }) => {
                            if let Stage::Create { operation_id, .. } = stage {
                                self.creation_failed(operation_id, error)?;
                            }
                        }
                        Err(error) => {
                            let setup = matches!(stage, Stage::Servers);
                            if self.recovery.is_some() {
                                self.reconnect_retry(reconnect::Failure::of(&error))?;
                            } else {
                                self.unavailable(
                                    "Session changed or is unavailable — refresh to retry",
                                )?;
                                if setup {
                                    self.offer_local_setup()?;
                                }
                            }
                        }
                    }
                }
            }
            if let Some(response) = self.split.poll(self.active.as_ref())? {
                self.emit(Incoming::Split(response))?;
            }
            self.preference_tick()?;
            self.agent_tick()?;
            if self.foreground
                && self.recovery.as_ref().is_some_and(|r| r.waiting())
                && self.stage.is_none()
            {
                match input.recv_timeout(Duration::from_millis(50)) {
                    Ok(command) => self.command(command)?,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return self.cancel(),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            } else if !self.sources.catalog_busy()?
                && !self.background_fleet.busy()
                && !self.split.busy()
                && !self.agents.busy()
                && (self.stage.is_none()
                    || (!self.foreground
                        && !self.submitted
                        && matches!(self.stage, Some(Stage::Issue { .. }))))
            {
                // Idle catalogs have no polling timer. Only outstanding HTTP
                // work needs periodic mailbox checks; terminal IO has its own loop.
                // Both commands and registry notifications unpark this actor.
                // The unpark token closes the mailbox-check/begin-wait race.
                if let Some(wait) = self
                    .fleet_recovery_wait()
                    .into_iter()
                    .chain(self.agents.wait())
                    .min()
                {
                    std::thread::park_timeout(wait);
                } else {
                    std::thread::park();
                }
            } else {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    fn completed(&mut self, stage: Stage, result: CatalogResult) -> Result<(), Error> {
        match (stage, result) {
            (Stage::AgentOpen { target, .. }, CatalogResult::AgentOpened(opened)) => {
                if opened.panes.is_empty() || opened.panes.len() > 24 {
                    return self.unavailable("Session exceeds the native stream pane limit");
                };
                self.stage = Some(Stage::Issue {
                    target,
                    workspace: opened.workspace_name,
                    panes: opened.panes,
                    selected: opened.selected,
                });
            }
            (Stage::LocalProve, CatalogResult::LocalSessionProof(proof)) => {
                self.local_creation_proved(proof)?
            }
            (Stage::LocalCreate { proof, .. }, CatalogResult::Created(receipt)) => {
                self.stage = Some(Stage::LocalCatalog { proof, receipt });
                self.state.status = "Finding created session".into();
                self.publish()?;
            }
            (Stage::LocalCatalog { receipt, .. }, CatalogResult::FleetCatalog(snapshot)) => {
                self.local_creation_catalog(receipt, snapshot)?
            }
            (Stage::Preferences { .. }, CatalogResult::FleetPreferences { state, owner }) => {
                self.preference_received(state, owner)?
            }
            (Stage::AddMachine { .. }, CatalogResult::MachinePrepared(value)) => {
                self.machine_prepared(value)?
            }
            (Stage::VerifyProfile, CatalogResult::SavedMachines(value)) => {
                self.registry_received(value)?;
                if self.selected_profile.is_some() {
                    self.stage = Some(Stage::Servers);
                }
            }
            (Stage::MachineSelection { expected, id }, CatalogResult::SavedMachines(value)) => {
                self.machine_selected(expected, id, value)?;
            }
            (Stage::Machines { .. }, CatalogResult::SavedMachines(value)) => {
                self.registry_received(value)?;
            }
            (Stage::Owner { request, .. }, CatalogResult::PaneCreated(receipt)) => {
                self.owner_completed(request, Some(receipt))?
            }
            (Stage::Editor { request, .. }, CatalogResult::EditorOpened) => {
                self.editor_completed(request, Ok(()))?
            }
            (Stage::Create { scope, .. }, CatalogResult::Created(receipt)) => {
                self.creation_completed(scope, receipt)?;
            }
            (
                Stage::History {
                    id,
                    request,
                    operation_id,
                    ..
                },
                CatalogResult::History(result),
            ) => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|r| r.id == id && r.request == request)
                {
                    self.emit(Incoming::History(Response::from_native(
                        id,
                        request,
                        operation_id,
                        Ok(result),
                    )))?;
                }
            }
            (Stage::Servers, CatalogResult::FleetCatalog(snapshot)) => {
                self.receive_catalog(snapshot, true)?
            }
            (
                Stage::Open { target, preferred },
                CatalogResult::Opened {
                    workspace_name,
                    panes,
                },
            ) => {
                let Some(selected) = preferred
                    .filter(|id| panes.contains(id))
                    .or_else(|| panes.first().cloned())
                else {
                    return self.unavailable("Session has no attachable terminal panes");
                };
                if panes.len() > 24 {
                    return self.unavailable("Session exceeds the native stream pane limit");
                }
                self.stage = Some(Stage::Issue {
                    target,
                    workspace: workspace_name,
                    panes,
                    selected,
                });
            }
            (
                Stage::Issue {
                    target,
                    panes,
                    selected,
                    workspace,
                },
                CatalogResult::Issued(capability),
            ) => {
                let id = uuid::Uuid::new_v4().to_string();
                self.state.selected_pane = Some(selected);
                self.state.panes = panes
                    .into_iter()
                    .map(|id| Choice {
                        label: id.clone(),
                        id,
                        pane_count: None,
                        window_id: None,
                        browser_icon: None,
                        window_label: None,
                    })
                    .collect();
                self.state.status = "Connecting terminal".into();
                self.publish()?;
                self.emit(Incoming::Handoff(Event::Open {
                    version: 1,
                    id: id.clone(),
                    request: self.state.request,
                    live_session_id: target.live.clone(),
                    capability,
                }))?;
                self.active = Some(Route {
                    id,
                    request: self.state.request,
                    target,
                    workspace,
                });
            }
            _ => {
                return Err(Error::Invalid(
                    "native catalog result did not match its request",
                ));
            }
        }
        Ok(())
    }
    fn history(
        &mut self,
        id: String,
        request: u64,
        operation_id: u64,
        body: String,
    ) -> Result<(), Error> {
        let validated = (|| {
            let route = self
                .active
                .as_ref()
                .filter(|r| r.id == id && r.request == request)
                .ok_or(herdr_client::tmux_daemon::Error::Retired)?;
            let body = herdr_client::tmux_history::AnchorRequest::parse(body.as_bytes())
                .map_err(herdr_client::tmux_daemon::Error::History)?;
            let identity = body.identity();
            if self.stage.is_some()
                || body.live_session_id() != route.target.live
                || identity.0 != route.workspace
                || identity.2 != route.target.scope.generation
                || self.state.selected_pane.as_deref() != Some(identity.1)
            {
                return Err(herdr_client::tmux_daemon::Error::Retired);
            }
            Ok((route.target.scope.clone(), body))
        })();
        match validated {
            Ok((scope, body)) => {
                self.stage = Some(Stage::History {
                    scope,
                    id,
                    request,
                    operation_id,
                    body,
                });
                Ok(())
            }
            Err(error) => self.emit(Incoming::History(Response::from_native(
                id,
                request,
                operation_id,
                Err(error),
            ))),
        }
    }
}

#[cfg(test)]
#[path = "browser_native_local_old_daemon_live_tests.rs"]
mod old_daemon_live_tests;
#[cfg(test)]
#[path = "browser_native_local_restart_live_tests.rs"]
mod restart_live_tests;
#[cfg(test)]
#[path = "browser_native_local_tests.rs"]
mod tests;
