#![allow(clippy::unwrap_used)]
use super::*;
#[path = "browser_native_local_presence_tests.rs"]
mod presence;
fn fixture() -> (Local, mpsc::Receiver<Incoming>) {
    let path = PathBuf::from("/nonexistent-native-catalog-test/daemon.json");
    let (events, receiver) = mpsc::sync_channel(8);
    (
        Local {
            machine_id: "local".into(),
            machine_label: "Local".into(),
            catalog_identity: None,
            worker: CatalogWorker::spawn(path.clone()).unwrap(),
            events,
            state: State {
                home_phase: HomePhase::Live,
                ..State::default()
            },
            targets: BTreeMap::new(),
            stage: None,
            submitted: false,
            active: None,
            split: split::Reader::new(path.clone()).unwrap(),
            foreground: true,
            presence_revision: 0,
            editor: Default::default(),
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
            registry_worker: Some(CatalogWorker::spawn(path.clone()).unwrap()),
            registry_dirty: false,
            local_record: Some(path.clone()),
            sources: NativeOwner::new(CatalogSource::Local(path.clone())),
            selected_profile: None,
        },
        receiver,
    )
}
fn registration() -> ServerRegistration {
    ServerRegistration::Online {
        label: "Test".into(),
        scope: ServerScope {
            server_id: format!("tmux-server.{}", "a".repeat(32)),
            generation: uuid::Uuid::new_v4().to_string(),
        },
    }
}
fn token(local: &Local) -> String {
    local.state.fleet.as_ref().unwrap().groups[0].servers[0]
        .selection
        .clone()
        .unwrap()
}
#[test]
fn refreshed_catalog_rejects_old_server_selection() {
    let (mut local, _events) = fixture();
    local.catalog_servers(vec![registration()]);
    let old = token(&local);
    local.catalog_servers(vec![registration()]);
    assert!(local.state.fleet.as_ref().unwrap().valid());
    local.select_server(1, old).unwrap();
    assert_eq!(local.state.request, 0);
    assert!(local.state.selected_server.is_none());
    local.select_server(1, token(&local)).unwrap();
    assert_eq!(local.state.request, 1);
    assert!(
        local
            .state
            .selected_server
            .as_ref()
            .unwrap()
            .valid(local.state.fleet.as_ref().unwrap())
    );
}
#[test]
fn cancellation_retains_uncertain_creation_and_prevents_second_submission() {
    let (mut local, _events) = fixture();
    local.catalog_servers(vec![registration()]);
    local.select_server(1, token(&local)).unwrap();
    local.create(1, "first".into()).unwrap();
    let Some(Stage::Create { operation_id, .. }) = local.stage else {
        panic!("creation missing");
    };
    local.submitted = true;
    local.cancel().unwrap();
    assert_eq!(local.uncertain_create, Some(operation_id));
    local.creation_status();
    assert!(local.state.create_session.as_ref().unwrap().phase == CreatePhase::Failed);
    local.create(1, "duplicate".into()).unwrap();
    assert!(local.stage.is_none());
    local.home(2).unwrap();
    assert_eq!(local.uncertain_create, Some(operation_id));
}
#[test]
fn queued_creation_cancellation_does_not_claim_submission() {
    let (mut local, _events) = fixture();
    local.catalog_servers(vec![registration()]);
    local.select_server(1, token(&local)).unwrap();
    local.create(1, "first".into()).unwrap();
    local.cancel().unwrap();
    assert!(local.uncertain_create.is_none());
}

#[test]
fn machine_mutation_is_revision_fenced_and_navigation_preserves_uncertainty() {
    use herdr_client::tmux_daemon::{SavedMachine, SavedMachineRegistry};
    let (mut local, events) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    local.registry.finish(Ok(SavedMachineRegistry {
        version: 1,
        machines: vec![SavedMachine {
            id: id.clone(),
            label: "Build".into(),
            ssh_target: "build".into(),
            expected_environment_id: None,
            enabled: true,
        }],
    }));
    let revision = local.registry.publication().revision;
    local
        .machine_operation(
            0,
            machines::Operation::Mutate {
                revision: revision - 1,
                change: machines::Change::Disable { id: id.clone() },
            },
        )
        .unwrap();
    assert!(local.stage.is_none());
    local
        .machine_operation(
            0,
            machines::Operation::Mutate {
                revision,
                change: machines::Change::Disable { id },
            },
        )
        .unwrap();
    assert!(matches!(
        local.stage,
        Some(Stage::Machines { change: Some(_) })
    ));
    assert!(local.registry.publication().pending);
    local.submitted = true;
    local.home(1).unwrap();
    let publication = local.registry.publication();
    assert!(!publication.available && !publication.pending);
    assert!(publication.error.unwrap().contains("unconfirmed"));
    assert_eq!(publication.revision, revision + 1);
    drop(events);
}

#[cfg(unix)]
#[test]
fn saved_profile_selection_keeps_local_registry_and_revokes_on_authority_change() {
    use herdr_client::tmux_daemon::{SavedMachine, SavedMachineRegistry};
    let (mut local, events) = fixture();
    let profile = SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Build".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: Some(uuid::Uuid::new_v4().to_string()),
        enabled: true,
    };
    let value = SavedMachineRegistry {
        version: 1,
        machines: vec![profile.clone()],
    };
    local.registry.finish(Ok(value.clone()));
    local
        .select_machine(1, profile.id.clone(), local.registry.publication().revision)
        .unwrap();
    assert!(matches!(local.stage, Some(Stage::MachineSelection { .. })));
    // Simulate the matching local worker's verified catalog response.
    local.stage = None;
    local
        .machine_selected(value.clone(), profile.id.clone(), value.clone())
        .unwrap();
    assert_eq!(local.machine_id, profile.id);
    assert!(local.local_record.is_some() && local.registry_worker.is_some());
    assert_eq!(
        local
            .selected_profile
            .as_ref()
            .unwrap()
            .expected_environment_id,
        profile.expected_environment_id
    );
    while events.try_recv().is_ok() {}
    let mut disabled = value;
    disabled.machines[0].enabled = false;
    local.registry_received(disabled).unwrap();
    assert_eq!(local.machine_id, "local");
    assert!(local.selected_profile.is_none());
}
#[test]
fn changed_profile_cannot_connect_from_cached_selection() {
    use herdr_client::tmux_daemon::{SavedMachine, SavedMachineRegistry};
    let (mut local, _events) = fixture();
    let profile = SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Build".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: None,
        enabled: true,
    };
    let expected = SavedMachineRegistry {
        version: 1,
        machines: vec![profile.clone()],
    };
    let mut replacement = expected.clone();
    replacement.machines[0].ssh_target = "different.invalid".into();
    local
        .machine_selected(expected, profile.id, replacement)
        .unwrap();
    assert!(local.selected_profile.is_none());
    assert!(local.stage.is_none());
    assert!(local.state.home_phase == HomePhase::Unavailable);
}

#[test]
fn unchanged_watch_refresh_preserves_selection_revision_and_can_be_superseded() {
    use herdr_client::tmux_daemon::{SavedMachine, SavedMachineRegistry};
    let (mut local, _events) = fixture();
    let profile = SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Build".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: None,
        enabled: true,
    };
    let registry = SavedMachineRegistry {
        version: 1,
        machines: vec![profile.clone()],
    };
    local.registry.finish(Ok(registry.clone()));
    let revision = local.registry.publication().revision;
    local.registry.finish(Ok(registry));
    assert_eq!(local.registry.publication().revision, revision);
    local.read_registry();
    assert!(local.registry.publication().pending);
    local.select_machine(1, profile.id, revision).unwrap();
    assert_eq!(local.state.request, 1);
    assert!(matches!(local.stage, Some(Stage::MachineSelection { .. })));
}

#[test]
fn watch_invalidation_waits_for_foreground_mutation_receipt() {
    let (mut local, _events) = fixture();
    local.registry_dirty = true;
    local.registry.begin();
    local.stage = Some(Stage::VerifyProfile);
    local.watch_tick().unwrap();
    assert!(local.registry_dirty);
    assert!(matches!(local.stage, Some(Stage::VerifyProfile)));
    assert!(local.registry.publication().pending);
    local.stage = None;
    local.watch_tick().unwrap();
    assert!(!local.registry_dirty);
    assert!(matches!(
        local.stage,
        Some(Stage::Machines { change: None })
    ));
}

#[test]
fn add_machine_supersedes_refresh_but_cancelled_save_stays_uncertain() {
    let (mut local, _events) = fixture();
    local.read_registry();
    local.add_machine(1, "target".into()).unwrap();
    assert_eq!(local.state.request, 1);
    assert!(matches!(local.stage, Some(Stage::AddMachine { .. })));
    // A sent save can commit after navigation; cancellation must not imply rollback.
    local.submitted = true;
    local.cancel().unwrap();
    assert!(local.stage.is_none());
    assert!(!local.registry.publication().available);
    assert!(
        local
            .registry
            .publication()
            .error
            .unwrap()
            .contains("unconfirmed")
    );
}

#[test]
fn stable_session_identity_survives_refresh_without_reusing_selection_authority() {
    let (mut local, _events) = fixture();
    local.catalog_identity = Some(herdr_client::tmux_daemon::CatalogIdentity {
        instance_id: uuid::Uuid::new_v4().to_string(),
        environment_id: Some(uuid::Uuid::new_v4().to_string()),
    });
    let registration = registration();
    let scope = local.catalog_servers(vec![registration.clone()])[0].clone();
    let session = Session {
        live_session_id: format!("live-session.{}", "a".repeat(20)),
        session_name: "Build".into(),
        workspace_name: None,
        pane_count: 1,
    };
    let old = uuid::Uuid::new_v4().to_string();
    local.catalog_session(&old, &scope, &session).unwrap();
    let stable = local.state.fleet.as_ref().unwrap().groups[0].sessions[0]
        .id
        .clone();
    local.catalog_servers(vec![registration]);
    let fresh = uuid::Uuid::new_v4().to_string();
    local.catalog_session(&fresh, &scope, &session).unwrap();
    let fleet = local.state.fleet.as_ref().unwrap();
    assert!(fleet.valid());
    assert_eq!(fleet.groups[0].sessions[0].id, stable);
    assert!(fleet.session(&old).is_none());
    assert!(fleet.session(&stable).is_none());
    assert!(fleet.session(&fresh).is_some());
    local.home(1).unwrap();
    assert!(local.catalog_identity.is_none());
}

#[path = "browser_native_local_controls_tests.rs"]
mod controls;

#[path = "browser_native_local_refresh_tests.rs"]
mod refresh;

#[path = "browser_native_local_creation_tests.rs"]
mod local_creation;

#[path = "browser_native_local_topology_tests.rs"]
mod topology;

#[test]
fn agent_filter_rejects_stale_unknown_and_hidden_commands_without_navigation() {
    let (mut local, events) = fixture();
    local.catalog_servers(vec![registration()]);
    local.agent_tick().unwrap();
    let revision = local.state.home_agents.as_ref().unwrap().revision;
    while events.try_recv().is_ok() {}
    for (request, rev, machine) in [
        (1, revision, Some("local".into())),
        (0, revision + 1, Some("local".into())),
        (0, revision, Some("missing".into())),
    ] {
        local.filter_agents(request, rev, machine).unwrap();
        assert_eq!(local.state.home_agents.as_ref().unwrap().revision, revision);
        assert!(events.try_recv().is_err());
    }
    local.foreground = false;
    local
        .filter_agents(0, revision, Some("local".into()))
        .unwrap();
    assert!(events.try_recv().is_err());
    local.foreground = true;
    local.stage = Some(Stage::Servers);
    local
        .filter_agents(0, revision, Some("local".into()))
        .unwrap();
    let Incoming::Catalog(state) = events.try_recv().unwrap() else {
        panic!("expected catalog")
    };
    assert_eq!(
        state
            .home_agent_filter
            .as_ref()
            .unwrap()
            .machine_id
            .as_deref(),
        Some("local")
    );
    assert!(state.home_agents.as_ref().unwrap().revision > revision);
    assert_eq!(state.request, 0);
    assert!(state.selected_session.is_none());
    assert!(matches!(local.stage, Some(Stage::Servers)));
}
