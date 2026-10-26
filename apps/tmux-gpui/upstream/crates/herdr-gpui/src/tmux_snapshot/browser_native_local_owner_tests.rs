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
        live_session_id: route.target.live.clone(),
        generation: route.target.scope.generation.clone(),
        pane: "pane.fixture".into(),
        action: Action::NewWindow,
    };
    (route, request)
}
#[test]
fn owner_request_requires_current_scope_and_cannot_replay() {
    let (mut route, request) = fixture();
    let mut gate = Gate::default();
    assert!(
        gate.admit(Some(&route), Some(&request.pane), false, &request)
            .is_none()
    );
    assert!(
        gate.admit(Some(&route), Some("other"), true, &request)
            .is_none()
    );
    route.request = 2;
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, &request)
            .is_none()
    );
    route.request = 1;
    let (_, operation, creation) = gate
        .admit(Some(&route), Some(&request.pane), true, &request)
        .unwrap();
    assert_eq!(operation.to_string(), request.operation_id);
    assert_eq!(creation.workspace_name, route.workspace);
    let mut replay = request.clone();
    replay.sequence += 1;
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, &replay)
            .is_none()
    );
}
#[test]
fn owner_ledger_is_bounded_per_selection() {
    let (route, mut request) = fixture();
    let mut gate = Gate::default();
    for sequence in 1..=256 {
        request.sequence = sequence;
        request.operation_id = uuid::Uuid::new_v4().to_string();
        assert!(
            gate.admit(Some(&route), Some(&request.pane), true, &request)
                .is_some()
        );
    }
    request.sequence = 257;
    request.operation_id = uuid::Uuid::new_v4().to_string();
    assert!(
        gate.admit(Some(&route), Some(&request.pane), true, &request)
            .is_none()
    );
}
