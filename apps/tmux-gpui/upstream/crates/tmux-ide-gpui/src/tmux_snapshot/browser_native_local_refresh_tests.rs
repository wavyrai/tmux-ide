use super::*;
use herdr_client::tmux_daemon::{CatalogIdentity, FleetCatalog, FleetCatalogSessions};
#[test]
fn changed_home_catalog_preserves_current_tokens_but_retires_changed_generations() {
    let (mut local, _events) = fixture();
    let server = registration();
    let ServerRegistration::Online { scope, .. } = &server else {
        unreachable!()
    };
    let mut catalog = FleetCatalog {
        identity: CatalogIdentity {
            instance_id: uuid::Uuid::new_v4().to_string(),
            environment_id: None,
        },
        servers: vec![server.clone()],
        sessions: vec![FleetCatalogSessions {
            scope: scope.clone(),
            sessions: vec![Session {
                live_session_id: format!("live-session.{}", "a".repeat(20)),
                session_name: "Build".into(),
                workspace_name: None,
                pane_count: 1,
            }],
        }],
    };
    local.receive_catalog(catalog.clone(), false).unwrap();
    let first = local.state.sessions[0].id.clone();
    let selected = local.state.fleet.as_ref().unwrap().groups[0].servers[0].clone();
    let server_token = selected.selection.clone();
    local.accept_server(selected).unwrap();
    catalog.sessions[0].sessions[0].session_name = "Renamed".into();
    local.receive_catalog(catalog.clone(), false).unwrap();
    assert_eq!(local.state.sessions.len(), 1);
    assert_eq!(local.state.sessions[0].id, first);
    assert_eq!(local.state.sessions[0].label, "Renamed");
    assert_eq!(
        local.state.fleet.as_ref().unwrap().groups[0].servers[0].selection,
        server_token
    );
    assert!(local.state.selected_server.is_some());
    let generation = uuid::Uuid::new_v4().to_string();
    if let ServerRegistration::Online { scope, .. } = &mut catalog.servers[0] {
        scope.generation = generation.clone();
    }
    catalog.sessions[0].scope.generation = generation;
    local.receive_catalog(catalog, false).unwrap();
    assert_ne!(local.state.sessions[0].id, first);
    assert!(!local.targets.contains_key(&first));
    assert!(local.state.selected_server.is_none());
    assert!(local.state.fleet.as_ref().unwrap().valid());
}
