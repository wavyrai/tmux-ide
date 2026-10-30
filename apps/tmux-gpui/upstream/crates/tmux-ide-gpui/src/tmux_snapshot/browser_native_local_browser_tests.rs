//! Native browser controls survive failed reads and stale-revision clicks.
#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::tmux_daemon::{BrowserAction, Error as DaemonError};
fn fixture() -> Local {
    let path = PathBuf::from("/nonexistent-native-browser-controls-test/daemon.json");
    let (events, receiver) = mpsc::sync_channel(64);
    // Publications are not under test; keep the queue drained so publish never fails.
    std::thread::spawn(move || receiver.into_iter().for_each(drop));
    let route = Route {
        id: "route".into(),
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
    Local {
        machine_id: "local".into(),
        machine_label: "Local".into(),
        catalog_identity: None,
        worker: CatalogWorker::spawn(path.clone()).unwrap(),
        events,
        state: State {
            request: 1,
            selected_pane: Some("pane-a".into()),
            panes: vec![Choice {
                id: "pane-a".into(),
                label: "pane-a".into(),
                pane_count: None,
                window_id: Some("window-a".into()),
                window_label: None,
                browser_icon: None,
            }],
            ..State::default()
        },
        targets: BTreeMap::new(),
        stage: None,
        submitted: false,
        active: Some(route),
        split: split::Reader::new(path.clone()).unwrap(),
        foreground: true,
        presence_revision: 0,
        editor: Default::default(),
        browser_controls: Default::default(),
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
        sources: NativeOwner::new(CatalogSource::Local(path)),
        selected_profile: None,
    }
}
fn observed(revision: u64) -> BrowserState {
    BrowserState {
        version: 1,
        instance: "12345678-1234-4234-8234-123456789abc".into(),
        pane: "%1".into(),
        tab: 1,
        revision,
        enabled: true,
        url: "https://example.com".into(),
        title: format!("Example {revision}"),
        loading: false,
        can_go_back: true,
        can_go_forward: false,
    }
}
/// Runs the real bounded worker until its in-flight reply has been consumed.
fn settle(local: &mut Local) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while local.browser_controls.pending.is_some() {
        assert!(Instant::now() < deadline, "browser worker never replied");
        local.browser_controls_tick().unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn a_failed_read_keeps_the_last_good_controls() {
    let mut local = fixture();
    local
        .state
        .browser_controls
        .insert("pane-a".into(), observed(7));
    // The daemon record does not exist, so the read fails like a timed-out poll.
    local.browser_controls(1, "pane-a".into(), None).unwrap();
    settle(&mut local);
    assert!(local.state.browser_controls.get("pane-a") == Some(&observed(7)));
}
#[path = "browser_native_local_browser_retry_tests.rs"]
mod retry;
