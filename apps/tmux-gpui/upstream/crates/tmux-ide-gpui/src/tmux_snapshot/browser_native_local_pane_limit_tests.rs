//! A session over the native pane limit leaves Home live: the rest of the
//! catalog stays, and a notice names the session and what to do instead.
use super::*;
use herdr_client::tmux_daemon::Error as DaemonError;
use herdr_client::tmux_daemon::{
    AgentActivity, AgentSelection, CatalogIdentity, FleetCatalog, FleetCatalogSessions,
    ObservedAgent, ObservedHarness, OpenedAgent,
};

const SMALL: &str = "small";
const BIG: &str = "big";
const HUGE: &str = "38 windows";

fn live(name: &str) -> String {
    let fill: String = name.chars().filter(char::is_ascii_alphanumeric).collect();
    format!("live-session.{fill:a<20}")
}
fn session(name: &str, panes: u32, windows: Option<u32>) -> Session {
    Session {
        live_session_id: live(name),
        session_name: name.into(),
        workspace_name: None,
        pane_count: panes,
        window_count: windows,
        last_activity: None,
        favicon: None,
    }
}
/// A normal session, one with 25 panes, and one with 38 windows of one pane.
fn catalog(small_panes: u32) -> FleetCatalog {
    let server = registration();
    let ServerRegistration::Online { scope, .. } = &server else {
        unreachable!()
    };
    FleetCatalog {
        service_version: None,
        identity: CatalogIdentity {
            instance_id: uuid::Uuid::new_v4().to_string(),
            environment_id: None,
        },
        servers: vec![server.clone()],
        sessions: vec![FleetCatalogSessions {
            scope: scope.clone(),
            sessions: vec![
                session(SMALL, small_panes, Some(1)),
                session(BIG, 25, Some(3)),
                session(HUGE, 38, Some(38)),
            ],
        }],
    }
}
fn selection(local: &Local, target: &Target) -> AgentSelection {
    AgentSelection {
        catalog_identity: local.catalog_identity.clone().unwrap(),
        live_session_id: target.live.clone(),
        workspace_name: "fixture".into(),
        agent: ObservedAgent {
            id: "agent.one".into(),
            name: "Build".into(),
            harness: ObservedHarness::Codex,
            activity: AgentActivity::Running,
            attention: false,
            pane_id: Some("pane.p0".into()),
            window_id: None,
            native_identity: None,
            interaction_endpoint: None,
            team: None,
        },
    }
}
fn drain(events: &mpsc::Receiver<Incoming>) {
    while events.try_recv().is_ok() {}
}
fn loaded(small_panes: u32) -> (Local, mpsc::Receiver<Incoming>) {
    let (mut local, events) = fixture();
    local.receive_catalog(catalog(small_panes), false).unwrap();
    drain(&events);
    (local, events)
}
fn key(local: &Local, label: &str) -> String {
    let choice = local.state.sessions.iter().find(|c| c.label == label);
    choice.unwrap().id.clone()
}
fn panes(count: usize) -> Vec<String> {
    (0..count).map(|i| format!("pane.p{i}")).collect()
}
fn assert_live_home_with_notice(local: &Local, label: &str, count: u64) {
    assert_eq!(local.state.surface, Surface::Home);
    assert_ne!(local.state.home_phase, HomePhase::Unavailable);
    let notice = local.state.home_notice.as_deref().unwrap();
    assert!(
        notice.contains(&format!("“{label}” has {count} panes")),
        "{notice}"
    );
    assert!(
        notice.contains(&format!(
            "“{label}” has {count} panes. This app opens sessions with up to 24. Close panes"
        )),
        "{notice}"
    );
    assert!(
        notice.contains("Close panes until it has 24 or fewer"),
        "{notice}"
    );
    assert!(
        notice.ends_with("or attach to it with tmux in Terminal."),
        "{notice}"
    );
}

#[test]
fn an_oversized_session_in_the_catalog_is_refused_and_home_keeps_every_session() {
    let (mut local, events) = loaded(3);
    for (label, count) in [(BIG, 25), (HUGE, 38)] {
        local.open(7, key(&local, label), None).unwrap();
        drain(&events);
        assert!(local.stage.is_none(), "{label} must not reach the daemon");
        assert_eq!(local.state.home_phase, HomePhase::Live);
        assert_eq!(local.state.sessions.len(), 3);
        assert_eq!(local.state.request, 7);
        assert_live_home_with_notice(&local, label, count);
    }
    // Every other session still opens, and opening one clears the notice.
    local.open(8, key(&local, SMALL), None).unwrap();
    assert!(matches!(local.stage, Some(Stage::Open { .. })));
    assert!(local.state.home_notice.is_none());
}

#[test]
fn exactly_the_limit_still_opens() {
    let (mut local, _events) = loaded(24);
    local.open(1, key(&local, SMALL), None).unwrap();
    let Some(Stage::Open { target, preferred }) = local.stage.take() else {
        panic!("24 panes must open");
    };
    local
        .completed(
            Stage::Open { target, preferred },
            CatalogResult::Opened {
                workspace_name: "fixture".into(),
                panes: panes(24),
            },
        )
        .unwrap();
    assert!(matches!(local.stage, Some(Stage::Issue { ref panes, .. }) if panes.len() == 24));
    assert!(local.state.home_notice.is_none());
}

/// The catalog said 3 panes, but the session has 25 by the time it opens.
#[test]
fn a_session_that_grew_past_the_limit_returns_to_a_reloading_home_that_names_it() {
    let (mut local, events) = loaded(3);
    local.open(4, key(&local, SMALL), None).unwrap();
    let Some(stage) = local.stage.take() else {
        panic!("open missing");
    };
    local
        .completed(
            stage,
            CatalogResult::Opened {
                workspace_name: "fixture".into(),
                panes: panes(25),
            },
        )
        .unwrap();
    drain(&events);
    // Home reloads like Refresh, not "the daemon could not list sessions".
    assert!(matches!(local.stage, Some(Stage::Servers)));
    assert_eq!(local.state.home_phase, HomePhase::Loading);
    assert_eq!(local.state.request, 4);
    assert!(local.recovery.is_none());
    assert_live_home_with_notice(&local, SMALL, 25);
    // The reload lists every session again and keeps the notice.
    let reload = local.stage.take().unwrap();
    local
        .completed(reload, CatalogResult::FleetCatalog(catalog(25)))
        .unwrap();
    drain(&events);
    assert_eq!(local.state.home_phase, HomePhase::Live);
    assert_eq!(local.state.sessions.len(), 3);
    // The initial catalog reads the machine registry next; it opens nothing.
    assert!(
        matches!(local.stage, Some(Stage::Machines { .. })),
        "the reload must not reopen the session"
    );
    assert_live_home_with_notice(&local, SMALL, 25);
}

#[test]
fn an_agent_open_over_the_limit_is_handled_the_same_way() {
    let (mut local, events) = loaded(3);
    local.open(5, key(&local, SMALL), None).unwrap();
    let Some(Stage::Open { target, .. }) = local.stage.take() else {
        panic!("open missing");
    };
    let selection = selection(&local, &target);
    local
        .completed(
            Stage::AgentOpen {
                target,
                selection: Box::new(selection),
            },
            CatalogResult::AgentOpened(OpenedAgent {
                workspace_name: "fixture".into(),
                panes: panes(25),
                selected: "pane.p0".into(),
            }),
        )
        .unwrap();
    drain(&events);
    assert!(matches!(local.stage, Some(Stage::Servers)));
    assert_live_home_with_notice(&local, SMALL, 25);
}

#[test]
fn a_remote_notice_says_which_machine_to_attach_on() {
    let (mut local, _events) = loaded(3);
    local.machine_id = uuid::Uuid::new_v4().to_string();
    local.machine_label = "build-mac".into();
    local.open(2, key(&local, BIG), None).unwrap();
    let notice = local.state.home_notice.unwrap();
    assert!(
        notice.ends_with("or attach to it with tmux in a terminal on build-mac."),
        "{notice}"
    );
}

#[test]
fn rows_over_the_limit_say_they_are_too_many_to_open() {
    let (local, _events) = loaded(24);
    let label = |name: &str| {
        let choice = local.state.sessions.iter().find(|c| c.label == name);
        choice.unwrap().pane_count_label().unwrap()
    };
    assert_eq!(label(SMALL), "24 panes");
    assert_eq!(label(BIG), "25 panes · too many");
    assert_eq!(label(HUGE), "38 panes · too many");
}

/// Reconnecting and fault status replace the notice for good (review of #351).
#[test]
fn a_catalog_failure_after_the_notice_says_reconnecting() {
    let (mut local, events) = loaded(3);
    local.open(3, key(&local, BIG), None).unwrap();
    assert!(local.state.home_notice.is_some());
    local
        .home_catalog_failed(DaemonError::ServerChanged)
        .unwrap();
    drain(&events);
    assert!(local.state.home_notice.is_none());
    assert_eq!(local.state.status, "Reconnecting…");
    // A click while Home reconnects says so, not the old notice.
    local.open(4, key(&local, SMALL), None).unwrap();
    drain(&events);
    assert!(local.stage.is_none());
    assert!(local.state.home_notice.is_none());
    assert_eq!(local.state.status, "Still reconnecting…");
}

#[test]
fn a_fault_after_the_notice_shows_the_fault() {
    let (mut local, events) = loaded(3);
    local.open(3, key(&local, BIG), None).unwrap();
    local
        .home_catalog_failed(DaemonError::Incompatible(3))
        .unwrap();
    drain(&events);
    assert!(local.state.home_notice.is_none());
    assert!(
        local.state.status.contains("needs an update"),
        "{}",
        local.state.status
    );
    local.open(4, key(&local, BIG), None).unwrap();
    drain(&events);
    assert!(
        local.state.home_notice.is_none(),
        "a blocked click must not bring the notice back"
    );
}

/// An agent open with no panes keeps the old unavailable path.
#[test]
fn an_agent_open_with_no_panes_is_unavailable() {
    let (mut local, events) = loaded(3);
    local.open(5, key(&local, SMALL), None).unwrap();
    let Some(Stage::Open { target, .. }) = local.stage.take() else {
        panic!("open missing");
    };
    local
        .completed(
            Stage::AgentOpen {
                target: target.clone(),
                selection: Box::new(selection(&local, &target)),
            },
            CatalogResult::AgentOpened(OpenedAgent {
                workspace_name: "fixture".into(),
                panes: Vec::new(),
                selected: "pane.p0".into(),
            }),
        )
        .unwrap();
    drain(&events);
    assert_eq!(local.state.home_phase, HomePhase::Unavailable);
    assert_eq!(
        local.state.status,
        "Session exceeds the native stream pane limit"
    );
    assert!(local.stage.is_none());
}

/// The app's limit must equal the one the daemon enforces at issue.
#[test]
fn the_native_limit_matches_the_contract() {
    let contract = include_str!("../../../../../../../packages/contracts/src/pane-stream.ts");
    let line = contract
        .lines()
        .find(|l| l.starts_with("export const PANE_STREAM_MAX_PANES = "))
        .unwrap();
    let value = line
        .trim_start_matches("export const PANE_STREAM_MAX_PANES = ")
        .trim_end_matches(';');
    assert_eq!(value.parse::<u64>().unwrap(), NATIVE_STREAM_MAX_PANES);
}

/// A recovered session that is now over the limit ends its recovery and keeps
/// the notice; later clicks still explain themselves (review round 2).
#[test]
fn a_recovery_refused_for_the_pane_limit_ends_and_keeps_the_notice() {
    let (mut local, events) = loaded(3);
    let big = local.targets[&key(&local, BIG)].clone();
    local.recovery = Some(reconnect::Recovery::of(big));
    assert!(local.reconnect_catalog().unwrap());
    drain(&events);
    assert!(local.stage.is_none());
    assert!(
        local.recovery.is_none(),
        "nothing retries a refused recovery"
    );
    assert_live_home_with_notice(&local, BIG, 25);
    local.publish().unwrap();
    drain(&events);
    assert_live_home_with_notice(&local, BIG, 25);
    local.open(9, key(&local, BIG), None).unwrap();
    drain(&events);
    assert_live_home_with_notice(&local, BIG, 25);
}

/// A recovery that can still open keeps going.
#[test]
fn a_recovery_under_the_limit_keeps_recovering() {
    let (mut local, events) = loaded(3);
    let small = local.targets[&key(&local, SMALL)].clone();
    local.recovery = Some(reconnect::Recovery::of(small));
    assert!(local.reconnect_catalog().unwrap());
    drain(&events);
    assert!(matches!(local.stage, Some(Stage::Open { .. })));
    assert!(local.recovery.is_some());
    assert!(local.state.home_notice.is_none());
}
