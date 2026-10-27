use super::*;
use herdr_client::tmux_daemon::{
    CatalogIdentity, CreateOutcome, FleetCatalog, FleetCatalogSessions,
};

fn created() -> (CreatedSession, FleetCatalog) {
    let server = registration();
    let ServerRegistration::Online { scope, .. } = &server else {
        unreachable!()
    };
    let generation = uuid::Uuid::new_v4().to_string();
    let live = format!("live-session.{}", "a".repeat(20));
    let receipt = CreatedSession {
        operation_id: uuid::Uuid::new_v4().to_string(),
        daemon_instance_id: generation.clone(),
        outcome: CreateOutcome::Created,
        live_session_id: Some(live.clone()),
        fleet_session_id: "session.0123456789abcdef".into(),
        workspace_name: "fixture".into(),
        display_name: "Fixture".into(),
    };
    let catalog = FleetCatalog {
        identity: CatalogIdentity {
            instance_id: generation,
            environment_id: None,
        },
        servers: vec![server.clone()],
        sessions: vec![FleetCatalogSessions {
            scope: scope.clone(),
            sessions: vec![Session {
                live_session_id: live,
                session_name: "Fixture".into(),
                workspace_name: None,
                pane_count: 1,
            }],
        }],
    };
    (receipt, catalog)
}

#[test]
fn receipt_opens_only_the_exact_created_session() {
    let (mut local, _events) = fixture();
    let (receipt, mut catalog) = created();
    let mut other = catalog.sessions[0].sessions[0].clone();
    other.live_session_id = format!("live-session.{}", "b".repeat(20));
    catalog.sessions[0].sessions.insert(0, other);
    local
        .local_creation_catalog(receipt.clone(), catalog)
        .unwrap();
    assert_eq!(local.state.surface, Surface::Workspace);
    assert_eq!(local.state.selected_session, receipt.live_session_id);
    assert!(matches!(local.stage, Some(Stage::Open { .. })));
    assert!(local.uncertain_create.is_none());
}

#[test]
fn receipt_never_guesses_after_owner_or_catalog_changes() {
    for case in 0..5 {
        let (mut local, _events) = fixture();
        let (mut receipt, mut catalog) = created();
        match case {
            0 => catalog.identity.instance_id = uuid::Uuid::new_v4().to_string(),
            1 => catalog.sessions.clear(),
            2 => catalog.sessions.push(catalog.sessions[0].clone()),
            3 => catalog.servers.clear(),
            _ => receipt.live_session_id = None,
        }
        let operation = uuid::Uuid::parse_str(&receipt.operation_id).unwrap();
        local.local_creation_catalog(receipt, catalog).unwrap();
        assert_eq!(local.state.surface, Surface::Home);
        assert_eq!(local.state.home_phase, HomePhase::Unavailable);
        assert_eq!(local.uncertain_create, Some(operation));
        assert!(local.stage.is_none());
    }
}

#[test]
fn empty_catalog_proves_only_foreground_local_creation() {
    for case in 0..4 {
        let (mut local, _events) = fixture();
        let (_, mut catalog) = created();
        catalog.servers.clear();
        catalog.sessions.clear();
        match case {
            1 => local.foreground = false,
            2 => local.machine_id = "remote".into(),
            3 => local.uncertain_create = Some(uuid::Uuid::new_v4()),
            _ => {}
        }
        local.receive_catalog(catalog, false).unwrap();
        assert_eq!(matches!(local.stage, Some(Stage::LocalProve)), case == 0);
        assert!(local.state.local_session_create.is_none());
    }
}

#[test]
fn focus_loss_cancels_pending_proof_without_claiming_creation() {
    let (mut local, _events) = fixture();
    local.stage = Some(Stage::LocalProve);
    local.submitted = true;
    local.local_creation_presence(false).unwrap();
    assert!(local.stage.is_none());
    assert!(!local.submitted);
    assert!(local.uncertain_create.is_none());
    assert_eq!(local.state.home_phase, HomePhase::Unavailable);
}

#[test]
fn local_creation_preempts_background_preferences() {
    let (mut local, _events) = fixture();
    local.stage = Some(Stage::Preferences { change: None });
    local
        .preempt_background_preference(&Command::CreateLocalSession {
            request: 0,
            action: uuid::Uuid::new_v4().to_string(),
            name: "Fixture".into(),
        })
        .unwrap();
    assert!(local.stage.is_none());
    local
        .create_local_session(0, "unproven".into(), "Fixture".into())
        .unwrap();
    assert!(local.stage.is_none());
}

#[test]
fn foreground_server_selection_preempts_registry_refresh() {
    let (mut local, _events) = fixture();
    local.catalog_servers(vec![registration()]);
    let selection = token(&local);
    local.read_registry();
    local
        .command(Command::FleetServer {
            request: 1,
            selection,
        })
        .unwrap();
    assert_eq!(local.state.request, 1);
    assert!(local.state.selected_server.is_some());
    assert!(local.stage.is_none());
}

#[test]
fn workspace_server_selection_retires_terminal_view_and_admits_creation() {
    for valid in [false, true] {
        let (mut local, _events) = fixture();
        local.catalog_servers(vec![registration()]);
        let selection = if valid {
            token(&local)
        } else {
            "stale-server".into()
        };
        local.state.surface = Surface::Workspace;
        local.state.selected_session = Some("existing-session".into());
        local.state.input_ready = true;
        local
            .command(Command::FleetServer {
                request: 1,
                selection,
            })
            .unwrap();
        if valid {
            assert_eq!(local.state.surface, Surface::Home);
            assert_eq!(local.state.request, 1);
            assert!(local.state.selected_session.is_none());
            assert!(!local.state.input_ready);
            assert!(local.state.selected_server.is_some());
            local.create(1, "New session".into()).unwrap();
            assert!(matches!(local.stage, Some(Stage::Create { .. })));
        } else {
            assert_eq!(local.state.surface, Surface::Workspace);
            assert_eq!(local.state.request, 0);
            assert_eq!(
                local.state.selected_session.as_deref(),
                Some("existing-session")
            );
        }
    }
}
