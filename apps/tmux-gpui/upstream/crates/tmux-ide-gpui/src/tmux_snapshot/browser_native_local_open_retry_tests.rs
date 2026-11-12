#![allow(clippy::unwrap_used)]
//! Found by the request-count run on 12 Nov 2026: a session created in the app
//! was opened before the daemon listed its pane, and the window stopped on
//! "Session has no attachable terminal panes" until refreshed.
use super::super::reconnect::tests::{attached, last_catalog};
use super::*;

fn target(local: &Local) -> Target {
    local.active.as_ref().unwrap().target.clone()
}
/// The daemon opened the session and listed no pane.
fn opened_empty(local: &mut Local, target: &Target) {
    let stage = Stage::Open {
        target: target.clone(),
        preferred: Some("%2".into()),
    };
    let result = CatalogResult::Opened {
        workspace_name: "fixture".into(),
        panes: Vec::new(),
    };
    local.completed(stage, result).unwrap();
}
/// A session being opened: no stream yet.
fn opening() -> (Local, mpsc::Receiver<Incoming>, Target) {
    let (mut local, events) = attached();
    let target = target(&local);
    local.active = None;
    local.state.status = "Opening terminal".into();
    (local, events, target)
}

#[test]
fn a_session_opened_without_panes_is_opened_again_before_the_window_stops() {
    let (mut local, events, target) = opening();
    let mut waits = Vec::new();
    for _ in 0..5 {
        let before = Instant::now();
        opened_empty(&mut local, &target);
        assert!(local.state.home_phase != HomePhase::Unavailable);
        assert_eq!(local.state.status, "Opening terminal");
        assert!(local.stage.is_none());
        // Not before it is due.
        local.empty_open_tick().unwrap();
        assert!(local.stage.is_none(), "opened again without waiting");
        let wait = local.empty_open_wait().unwrap();
        assert!(wait <= before.elapsed() + Duration::from_millis(1600));
        waits.push((wait.as_millis() + 5) / 100 * 100);
        local.empty_open.due_now();
        local.empty_open_tick().unwrap();
        let Some(Stage::Open {
            target: again,
            preferred,
        }) = &local.stage
        else {
            panic!("the open was not tried again");
        };
        assert_eq!(again.live, target.live);
        assert_eq!(again.scope, target.scope);
        assert_eq!(preferred.as_deref(), Some("%2"));
        local.stage = None;
    }
    assert_eq!(waits, [100, 200, 400, 800, 1600]);
    // Still none after about three seconds: now it is said.
    opened_empty(&mut local, &target);
    let published = last_catalog(&events);
    assert!(published.home_phase == HomePhase::Unavailable);
    assert_eq!(published.status, "Session has no attachable terminal panes");
    assert!(local.empty_open_wait().is_none());
}

#[test]
fn a_session_that_lists_its_pane_on_a_later_try_opens() {
    let (mut local, _events, target) = opening();
    opened_empty(&mut local, &target);
    local.empty_open.due_now();
    local.empty_open_tick().unwrap();
    let stage = local.stage.take().unwrap();
    let result = CatalogResult::Opened {
        workspace_name: "fixture".into(),
        panes: vec!["%2".into()],
    };
    local.completed(stage, result).unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
    // The lease is under way: nothing is opened again.
    local.empty_open.due_now();
    local.empty_open_tick().unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { .. })));
}

#[test]
fn leaving_the_session_ends_the_tries() {
    let (mut local, _events, target) = opening();
    opened_empty(&mut local, &target);
    local.home(8).unwrap();
    local.stage = None;
    local.empty_open.due_now();
    local.empty_open_tick().unwrap();
    assert!(local.stage.is_none(), "an abandoned session was opened");
    assert!(local.empty_open_wait().is_none());
}

/// While reconnecting, a session that is listed but has no pane to attach yet
/// (its server owner was just rebuilt) is one more failed try, not a stop.
#[test]
fn a_reconnect_that_finds_no_panes_yet_keeps_reconnecting() {
    let (mut local, _events) = attached();
    let target = target(&local);
    local.reconnect_start().unwrap();
    opened_empty(&mut local, &target);
    assert!(
        local
            .recovery
            .as_ref()
            .is_some_and(reconnect::Recovery::waiting)
    );
    assert_eq!(local.state.status, reconnect::RECONNECTING);
    assert_eq!(local.state.surface, Surface::Workspace);
    assert!(local.empty_open_wait().is_none());
}
