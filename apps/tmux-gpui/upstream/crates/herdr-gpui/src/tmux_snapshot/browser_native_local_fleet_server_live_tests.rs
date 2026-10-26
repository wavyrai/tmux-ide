//! Server selection and creation in an explicitly owned scratch fleet only.
use super::*;
pub(super) fn exercise(bridge: &Bridge, home: State, profile: &str, input: &str) -> State {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_ALLOW_MUTATION").as_deref(),
        Ok("owned-scratch-fleet")
    );
    let request = home.request + 1;
    let server = &home
        .fleet
        .as_ref()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.id == profile)
        .unwrap()
        .servers[0];
    let server_id = server.id.clone();
    let generation = server.generation.clone().unwrap();
    bridge
        .commands
        .send(Command::FleetServer {
            request,
            selection: server.selection.clone().unwrap(),
        })
        .unwrap();
    let prepared = until(bridge, |s| {
        s.request == request
            && s.home_phase == HomePhase::Live
            && s.create_session
                .as_ref()
                .is_some_and(|create| create.phase == CreatePhase::Idle)
    });
    let selected = prepared.selected_server.as_ref().unwrap();
    assert_eq!(selected.machine_id, profile);
    assert_eq!(selected.server_id, server_id);
    assert_eq!(selected.generation, generation);
    assert!(prepared.frame.is_none());
    bridge
        .commands
        .send(Command::CreateSession {
            request,
            name: "Native background server session".into(),
        })
        .unwrap();
    let created = until(bridge, |s| {
        s.request == request && s.frame.is_some() && s.input_ready
    });
    assert!(
        created
            .sessions
            .iter()
            .any(|session| session.label == "Native background server session")
    );
    bridge
        .commands
        .send(Command::Home {
            request: request + 1,
        })
        .unwrap();
    let home = until(bridge, |s| {
        s.request == request + 1
            && s.home_phase == HomePhase::Live
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups
                    .iter()
                    .any(|g| g.id == profile && g.disconnect.is_some())
            })
    });
    let disconnect = home
        .fleet
        .as_ref()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.id == profile)
        .unwrap()
        .disconnect
        .clone()
        .unwrap();
    bridge
        .commands
        .send(Command::FleetDisconnect {
            request: request + 1,
            disconnect,
        })
        .unwrap();
    let stopped = until(bridge, |s| {
        s.request == request + 1
            && s.home_phase == HomePhase::Live
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups
                    .iter()
                    .any(|g| g.id == profile && g.retry.is_some())
            })
    });
    assert!(stopped.frame.is_none());
    let retry = stopped
        .fleet
        .as_ref()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.id == profile)
        .unwrap()
        .retry
        .clone()
        .unwrap();
    bridge
        .commands
        .send(Command::FleetRetry {
            request: request + 1,
            retry,
        })
        .unwrap();
    eprintln!("NATIVE_SELECTED_DISCONNECT_VERIFIED");
    let local = until(bridge, |s| {
        s.request == request + 1
            && s.surface == Surface::Home
            && s.home_phase == HomePhase::Live
            && preferences_ready(s)
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups.iter().any(|g| {
                    g.id == profile
                        && g.sessions
                            .iter()
                            .any(|session| session.name == input && session.selection.is_some())
                })
            })
    });
    assert!(local.frame.is_none());
    eprintln!("NATIVE_BACKGROUND_SERVER_CREATION_VERIFIED");
    controls(bridge, local, profile, input)
}
fn controls(bridge: &Bridge, local: State, profile: &str, input: &str) -> State {
    let request = local.request;
    let disconnect = local
        .fleet
        .as_ref()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.id == profile)
        .unwrap()
        .disconnect
        .clone()
        .unwrap();
    bridge
        .commands
        .send(Command::FleetDisconnect {
            request,
            disconnect,
        })
        .unwrap();
    let stopped = until(bridge, |s| {
        s.request == request
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups.iter().any(|g| {
                    g.id == profile && g.state == fleet::Phase::Disconnected && g.retry.is_some()
                })
            })
    });
    assert!(stopped.frame.is_none());
    let retry = stopped
        .fleet
        .as_ref()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.id == profile)
        .unwrap()
        .retry
        .clone()
        .unwrap();
    bridge
        .commands
        .send(Command::FleetRetry { request, retry })
        .unwrap();
    let ready = until(bridge, |s| {
        s.request == request
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups.iter().any(|g| {
                    g.id == profile
                        && g.disconnect.is_some()
                        && g.sessions
                            .iter()
                            .any(|row| row.name == input && row.selection.is_some())
                })
            })
    });
    assert!(ready.frame.is_none());
    eprintln!("NATIVE_BACKGROUND_CONNECTION_CONTROLS_VERIFIED");
    ready
}

pub(super) fn selected_catalog(bridge: &Bridge, home: State) -> State {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_ALLOW_MUTATION").as_deref(),
        Ok("owned-scratch-fleet")
    );
    let request = home.request;
    let original = home.sessions[0].clone();
    eprintln!("NATIVE_SELECTED_CATALOG_ADD_READY");
    let added = until(bridge, |s| {
        s.request == request
            && s.frame.is_none()
            && s.sessions
                .iter()
                .any(|row| row.label == "native-selected-push")
    });
    assert!(
        added
            .sessions
            .iter()
            .any(|row| row.label == original.label && row.id == original.id)
    );
    eprintln!("NATIVE_SELECTED_CATALOG_REMOVE_READY");
    let removed = until(bridge, |s| {
        s.request == request
            && s.frame.is_none()
            && s.home_phase == HomePhase::Live
            && !s
                .sessions
                .iter()
                .any(|row| row.label == "native-selected-push")
    });
    assert!(
        removed
            .sessions
            .iter()
            .any(|row| row.label == original.label && row.id == original.id)
    );
    eprintln!("NATIVE_SELECTED_CATALOG_VERIFIED");
    removed
}
