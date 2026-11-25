//! Card #878: a catalog started after the terminal loop ended reopens the
//! window's session, found by its live id, at the same request and focus.
use super::*;
use herdr_client::tmux_daemon::{CatalogIdentity, FleetCatalog, FleetCatalogSessions, Session};

fn live(name: &str) -> String {
    format!("live-session.{name:a<20}")
}
fn catalog() -> FleetCatalog {
    let server = registration();
    let ServerRegistration::Online { scope, .. } = &server else {
        unreachable!()
    };
    let session = |name: &str| Session {
        live_session_id: live(name),
        session_name: name.into(),
        workspace_name: None,
        pane_count: 2,
        window_count: Some(1),
        last_activity: None,
        favicon: None,
        largest_window_pane_count: None,
    };
    FleetCatalog {
        service_version: None,
        identity: CatalogIdentity {
            instance_id: "instance-a".into(),
            environment_id: None,
        },
        servers: vec![server.clone()],
        sessions: vec![FleetCatalogSessions {
            scope: scope.clone(),
            sessions: vec![session("alpha"), session("beta")],
        }],
    }
}
fn seen(session: &str) -> Seen {
    Seen {
        request: 7,
        presence: (false, 3),
        session: Some(live(session)),
        pane: Some("%2".into()),
    }
}

#[test]
fn a_restarted_catalog_reopens_the_session_on_its_pane_at_the_same_request() {
    let (mut local, _events) = fixture();
    local.resume_from(&seen("beta"));
    assert_eq!(local.state.request, 7);
    assert_eq!((local.foreground, local.presence_revision), (false, 3));
    assert_eq!(local.state.surface, Surface::Workspace);
    assert_eq!(local.state.status, reconnect::RECONNECTING);
    local.receive_catalog(catalog(), true).unwrap();
    let Some(Stage::Open { target, preferred }) = &local.stage else {
        panic!("the session was not reopened");
    };
    assert_eq!(target.live, live("beta"));
    assert_eq!(preferred.as_deref(), Some("%2"));
    assert_eq!(local.state.request, 7);
    assert_eq!(local.state.surface, Surface::Workspace);
    assert_eq!(local.state.selected_session, Some(live("beta")));
    // Once only: a later catalog does not reopen it again.
    local.stage = None;
    local.receive_catalog(catalog(), true).unwrap();
    assert!(!matches!(local.stage, Some(Stage::Open { .. })));
}

#[test]
fn a_restarted_catalog_without_the_session_shows_home() {
    let (mut local, _events) = fixture();
    local.resume_from(&seen("gone"));
    local.receive_catalog(catalog(), true).unwrap();
    assert!(!matches!(local.stage, Some(Stage::Open { .. })));
    assert_eq!(local.state.request, 7);
    assert_eq!(local.state.surface, Surface::Home);
    assert_eq!(local.state.selected_session, None);
    assert_eq!(local.state.sessions.len(), 2);
}

#[test]
fn a_restart_from_home_keeps_home() {
    let (mut local, _events) = fixture();
    local.resume_from(&Seen {
        session: None,
        pane: None,
        ..seen("beta")
    });
    assert_eq!(local.state.surface, Surface::Home);
    local.receive_catalog(catalog(), true).unwrap();
    assert!(!matches!(local.stage, Some(Stage::Open { .. })));
    assert_eq!(local.state.request, 7);
}
