#![allow(clippy::unwrap_used)]
use super::*;
fn fixture() -> (Route, Request) {
    let route = Route {
        id: uuid::Uuid::new_v4().to_string(),
        request: 1,
        target: Target {
            scope: ServerScope {
                server_id: format!("tmux-server.{}", "a".repeat(32)),
                generation: uuid::Uuid::new_v4().to_string(),
            },
            live: format!("live-session.{}", "b".repeat(20)),
        },
        workspace: "fixture".into(),
    };
    let request = Request {
        version: 1,
        id: route.id.clone(),
        request: 1,
        sequence: 1,
        operation_id: uuid::Uuid::new_v4().to_string(),
        presence_revision: 4,
        pane: "pane.fixture".into(),
        generation: route.target.scope.generation.clone(),
        incarnation: "incarnation.fixture".into(),
    };
    (route, request)
}
#[test]
fn editor_click_requires_current_route_pane_and_presence() {
    let (mut route, request) = fixture();
    let mut gate = Gate::default();
    assert!(
        gate.admit(Some(&route), Some(&request.pane), false, 4, &request)
            .is_err()
    );
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, 5, &request)
            .is_err()
    );
    assert!(
        gate.admit(Some(&route), Some("other"), true, 4, &request)
            .is_err()
    );
    route.request = 2;
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, 4, &request)
            .is_err()
    );
    route.request = 1;
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, 4, &request)
            .is_ok()
    );
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, 4, &request)
            .is_err()
    );
}
#[test]
fn editor_operations_cannot_replay_with_a_new_sequence_and_are_bounded() {
    let (route, mut request) = fixture();
    let mut gate = Gate::default();
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, 4, &request)
            .is_ok()
    );
    request.sequence += 1;
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, 4, &request)
            .is_err()
    );
    for n in 2..=128 {
        request.sequence = n;
        request.operation_id = uuid::Uuid::new_v4().to_string();
        assert!(
            gate.admit(Some(&route), Some(&request.pane), true, 4, &request)
                .is_ok()
        );
    }
    request.sequence = 129;
    request.operation_id = uuid::Uuid::new_v4().to_string();
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, 4, &request)
            .is_err()
    );
}

#[test]
fn focus_and_pane_changes_cancel_editor_without_retiring_terminal() {
    let (route, request) = fixture();
    let path = PathBuf::from("/nonexistent-native-editor-test/daemon.json");
    let (events, _receiver) = mpsc::sync_channel(8);
    let mut local = Local {
        machine_id: "local".into(),
        machine_label: "Local".into(),
        catalog_identity: None,
        worker: CatalogWorker::spawn(path.clone()).unwrap(),
        events,
        state: State {
            request: 1,
            selected_pane: Some(request.pane.clone()),
            ..State::default()
        },
        targets: BTreeMap::new(),
        stage: None,
        submitted: false,
        active: Some(route),
        split: split::Reader::new(path.clone()).unwrap(),
        foreground: true,
        presence_revision: 4,
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
    };
    local.open_editor(request.clone()).unwrap();
    local.open_editor(request.clone()).unwrap();
    assert!(_receiver.try_recv().is_err());
    assert!(matches!(local.stage, Some(Stage::Editor { .. })));
    local
        .command(Command::NativeEditorCancel {
            value: Cancel {
                version: 1,
                id: request.id.clone(),
                request: 1,
                operation_id: uuid::Uuid::new_v4().to_string(),
            },
        })
        .unwrap();
    assert!(matches!(local.stage, Some(Stage::Editor { .. })));
    local
        .command(Command::Presence {
            active: false,
            revision: 5,
        })
        .unwrap();
    assert!(local.stage.is_none());
    assert!(local.active.is_some());
    // An old foreground notification cannot revive a cancelled action.
    local
        .command(Command::Presence {
            active: true,
            revision: 4,
        })
        .unwrap();
    assert!(!local.foreground);
    local.open_editor(request.clone()).unwrap();
    assert!(local.stage.is_none());
    local
        .command(Command::Presence {
            active: true,
            revision: 6,
        })
        .unwrap();
    let mut next = request;
    next.sequence = 2;
    next.operation_id = uuid::Uuid::new_v4().to_string();
    next.presence_revision = 6;
    local.open_editor(next.clone()).unwrap();
    assert!(matches!(local.stage, Some(Stage::Editor { .. })));
    local
        .command(Command::NativePaneSelected {
            id: next.id,
            from_request: 1,
            request: 2,
            pane: "pane.other".into(),
        })
        .unwrap();
    assert!(local.stage.is_none());
    assert_eq!(local.active.as_ref().unwrap().request, 2);
    assert!(local.editor.used.is_empty());
}
