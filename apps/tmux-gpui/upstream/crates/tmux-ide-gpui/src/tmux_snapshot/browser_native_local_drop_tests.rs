//! A connection drop keeps agents, Home's rows and the catalog; a reset
//! forgets them. See browser_native_local_drop.rs for the invariant.
use super::*;
use herdr_client::tmux_daemon::{
    CatalogIdentity, CatalogWatchError, Error as DaemonError, FleetCatalog, FleetCatalogSessions,
    Session,
};

fn roster() -> home_agents::Roster {
    serde_json::from_value(serde_json::json!({
        "revision":1,"phase":"live","observedSessions":1,"totalSessions":1,
        "truncatedSessions":0,"truncatedRows":0,"note":null,
        "rows":[{"key":"a","sessionId":"s","paneId":"p","name":"Codex","sessionLabel":"x",
            "status":"BLOCKED","attention":true,"available":true}]
    }))
    .unwrap()
}
fn workspace_roster() -> home_agents::WorkspaceRoster {
    serde_json::from_value(
        serde_json::json!({"sessionId":"s","revision":1,"phase":"live",
        "rows":[],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,
        "truncatedRows":0,"note":null}),
    )
    .unwrap()
}
fn catalog(instance: &str) -> FleetCatalog {
    let server = registration();
    let ServerRegistration::Online { scope, .. } = &server else {
        unreachable!()
    };
    let session = |name: &str| Session {
        live_session_id: format!("live-session.{:a<20}", name),
        session_name: name.into(),
        workspace_name: None,
        pane_count: 1,
        window_count: Some(1),
        last_activity: None,
        favicon: None,
    };
    FleetCatalog {
        service_version: None,
        identity: CatalogIdentity {
            instance_id: instance.into(),
            environment_id: None,
        },
        servers: vec![server.clone()],
        sessions: vec![FleetCatalogSessions {
            scope: scope.clone(),
            sessions: vec![session("alpha"), session("beta")],
        }],
    }
}
fn drained(events: &mpsc::Receiver<Incoming>) {
    while events.try_recv().is_ok() {}
}
fn closed() -> DaemonError {
    DaemonError::CatalogWatch(Box::new(CatalogWatchError::Closed))
}
fn attached(local: &mut Local) {
    let target = Target {
        scope: ServerScope {
            server_id: format!("tmux-server.{}", "a".repeat(32)),
            generation: uuid::Uuid::new_v4().to_string(),
        },
        live: "live-session.01234567890123456789".into(),
    };
    local.state.surface = Surface::Workspace;
    local.active = Some(Route {
        id: "route".into(),
        request: 0,
        target,
        workspace: "fixture".into(),
    });
    local.state.workspace_agents = Some(workspace_roster());
    local.state.home_agents = Some(roster());
}

#[test]
fn a_stream_drop_keeps_the_agents_and_a_reset_forgets_them() {
    let (mut local, events) = fixture();
    attached(&mut local);
    // The agent lane is running for this window, as it is before any drop.
    local.catalog_identity = Some(CatalogIdentity {
        instance_id: "instance-a".into(),
        environment_id: None,
    });
    local.agent_tick().unwrap();
    local.state.workspace_agents = Some(workspace_roster());
    local.state.home_agents = Some(roster());
    local.reconnect_start().unwrap();
    drained(&events);
    assert!(local.recovery.is_some());
    // The agent lane runs while the stream reconnects: it must not clear.
    local.agent_tick().unwrap();
    drained(&events);
    assert!(local.state.workspace_agents.is_some());
    assert!(local.state.home_agents.is_some());
    // Real navigation is a reset.
    local.home(1).unwrap();
    drained(&events);
    assert!(local.state.workspace_agents.is_none());
    assert!(local.state.home_agents.is_none());
}

#[test]
fn a_home_drop_keeps_the_agents() {
    let (mut local, events) = fixture();
    local.state.surface = Surface::Home;
    local.state.home_agents = Some(roster());
    local.home_catalog_failed(closed()).unwrap();
    local.agent_tick().unwrap();
    drained(&events);
    let shown = local.state.home_agents.as_ref().unwrap();
    assert_eq!(shown.rows.len(), 1, "the needs-input row stays");
    assert!(shown.rows[0].attention);
}

/// The same daemon dropped: Home's retry resumes the kept catalog's lane, with
/// no full read. A changed identity, record or owner reads it from scratch.
#[test]
fn a_same_daemon_drop_resumes_the_catalog_without_a_full_read() {
    for (error, resumes) in [
        (closed(), true),
        (
            DaemonError::CatalogWatch(Box::new(CatalogWatchError::Timeout)),
            true,
        ),
        // A plain network failure is the same daemon too (P06).
        (
            DaemonError::Network(ureq::Error::Io(std::io::Error::from(
                std::io::ErrorKind::ConnectionRefused,
            ))),
            true,
        ),
        (DaemonError::IdentityChanged, false),
        (DaemonError::RecordChanged, false),
        (DaemonError::OwnerExited, false),
    ] {
        let (mut local, events) = fixture();
        local.state.surface = Surface::Home;
        let snapshot = catalog("instance-a");
        local.receive_catalog(snapshot.clone(), false).unwrap();
        local.sources.seed_catalog(&snapshot).unwrap();
        drained(&events);
        let name = error.to_string();
        local.home_catalog_failed(error).unwrap();
        local.home.retry_now(Instant::now());
        local.home_recovery_tick().unwrap();
        drained(&events);
        assert_eq!(
            local.stage.is_none(),
            resumes,
            "{name}: resume instead of Stage::Servers"
        );
        assert_eq!(local.state.sessions.len(), 2, "{name}: the list stays");
    }
}

/// Back on the same daemon, the catalog keeps each row's id: Home doesn't
/// repaint. A different daemon gets fresh ids, so no row is attributed to it.
#[test]
fn home_rows_keep_their_ids_only_for_the_same_daemon() {
    let (mut local, events) = fixture();
    local.state.surface = Surface::Home;
    let snapshot = catalog("instance-a");
    local.receive_catalog(snapshot.clone(), false).unwrap();
    let before = local.state.sessions.clone();
    local.home_catalog_failed(closed()).unwrap();
    local.home_recovered();
    local.receive_catalog(snapshot.clone(), false).unwrap();
    drained(&events);
    assert!(
        local.state.sessions == before,
        "same daemon: identical rows"
    );
    // The same servers and sessions, from a different daemon.
    let mut other = snapshot;
    other.identity.instance_id = "instance-b".into();
    local.receive_catalog(other, false).unwrap();
    drained(&events);
    assert_eq!(local.state.sessions.len(), before.len());
    for row in &local.state.sessions {
        assert!(
            before.iter().all(|old| old.id != row.id),
            "a new daemon gets new ids"
        );
    }
}

/// The reset half of the invariant, where it happens: navigation, a refresh
/// and an unrecoverable stop forget every agent row and control (P11).
#[test]
fn navigation_refresh_and_a_stop_forget_the_agents() {
    for reset in ["refresh", "stop", "open-another-session"] {
        let (mut local, events) = fixture();
        attached(&mut local);
        local.catalog_identity = Some(CatalogIdentity {
            instance_id: "instance-a".into(),
            environment_id: None,
        });
        local.agent_tick().unwrap();
        local.state.workspace_agents = Some(workspace_roster());
        local.state.home_agents = Some(roster());
        local.state.agents_last_known = true;
        match reset {
            "refresh" => local.home(1).unwrap(),
            "stop" => local.unavailable("Stopped").unwrap(),
            _ => {
                let key = uuid::Uuid::new_v4().to_string();
                local.targets.insert(
                    key.clone(),
                    Target {
                        scope: ServerScope {
                            server_id: format!("tmux-server.{}", "b".repeat(32)),
                            generation: uuid::Uuid::new_v4().to_string(),
                        },
                        live: "live-session.98765432109876543210".into(),
                    },
                );
                local.open(2, key, None).unwrap();
            }
        }
        drained(&events);
        assert!(local.state.workspace_agents.is_none(), "{reset}");
        assert!(local.state.home_agents.is_none(), "{reset}");
        assert!(local.state.palette_agents.is_none(), "{reset}");
        assert!(local.state.attention_agents.is_none(), "{reset}");
        assert!(!local.state.agents_last_known, "{reset}");
    }
}

/// A long recovery keeps the rows and says, the whole time, that they are
/// last known; a reset clears both.
#[test]
fn a_long_recovery_publishes_last_known_and_a_reset_clears_it() {
    let (mut local, events) = fixture();
    attached(&mut local);
    local.catalog_identity = Some(CatalogIdentity {
        instance_id: "instance-a".into(),
        environment_id: None,
    });
    local.agent_tick().unwrap();
    local.state.workspace_agents = Some(workspace_roster());
    assert!(!local.state.agents_last_known);
    local.reconnect_start().unwrap();
    for _ in 0..200 {
        local.agent_tick().unwrap();
    }
    drained(&events);
    assert!(local.state.agents_last_known);
    assert!(local.state.workspace_agents.is_some());
    local.home(1).unwrap();
    drained(&events);
    assert!(!local.state.agents_last_known);
    assert!(local.state.workspace_agents.is_none());
}

fn published(events: &mpsc::Receiver<Incoming>) -> Option<State> {
    let mut last = None;
    while let Ok(event) = events.try_recv() {
        if let Incoming::Catalog(state) = event {
            last = Some(*state);
        }
    }
    last
}

/// #831: Home learns the service's version from its session list, with no
/// terminal open, and stops showing it once that list is no longer live.
#[test]
fn home_publishes_the_service_version_only_while_its_catalog_is_live() {
    let (mut local, events) = fixture();
    local.state.surface = Surface::Home;
    let mut snapshot = catalog("instance-a");
    snapshot.service_version = Some("2.9.22".into());
    local.receive_catalog(snapshot, true).unwrap();
    let state = published(&events).unwrap();
    assert_eq!(state.home_phase, HomePhase::Live);
    assert_eq!(state.service_version.as_deref(), Some("2.9.22"));
    // A version that is not a plain release string is never shown or exported.
    let mut odd = catalog("instance-a");
    odd.service_version = Some("2.9.22 /Users/secret".into());
    local.receive_catalog(odd, false).unwrap();
    assert_eq!(published(&events).unwrap().service_version, None);
    let mut snapshot = catalog("instance-a");
    snapshot.service_version = Some("2.9.22".into());
    local.receive_catalog(snapshot, false).unwrap();
    assert!(published(&events).unwrap().service_version.is_some());
    // The list is lost: the version goes with it.
    local.unavailable("No online tmux servers").unwrap();
    assert_eq!(published(&events).unwrap().service_version, None);
    // A fresh discovery forgets the old service before the new one answers.
    local.home(1).unwrap();
    assert_eq!(local.service_version, None);
    assert_eq!(published(&events).unwrap().service_version, None);
}
