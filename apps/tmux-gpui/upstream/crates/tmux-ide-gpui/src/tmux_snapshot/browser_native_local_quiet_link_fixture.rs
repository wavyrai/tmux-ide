#![allow(clippy::unwrap_used)]
//! Card #876: a window showing Home or an open session, for the quiet-link
//! tests of the catalog lane and of the agent rows.
use super::*;

pub(in crate::tmux_snapshot) fn snapshot() -> FleetCatalog {
    FleetCatalog {
        service_version: None,
        identity: CatalogIdentity {
            instance_id: "e01ce8ee-74d8-40d0-9a59-a096050a6ade".into(),
            environment_id: None,
        },
        servers: vec![],
        sessions: vec![],
    }
}
pub(in crate::tmux_snapshot) fn target() -> Target {
    Target {
        scope: ServerScope {
            server_id: "server".into(),
            generation: "generation".into(),
        },
        live: "$1".into(),
    }
}
/// A window showing Home, live, or (`session`) the open session `$1`.
pub(in crate::tmux_snapshot) fn window(session: bool) -> (Local, mpsc::Receiver<Incoming>) {
    let path = PathBuf::from("/nonexistent-quiet-link-test/daemon.json");
    let (events, receiver) = mpsc::sync_channel(64);
    let local = Local {
        machine_id: "local".into(),
        machine_label: "Local".into(),
        catalog_identity: Some(snapshot().identity),
        service_version: None,
        worker: CatalogWorker::spawn(path.clone()).unwrap(),
        events: events.into(),
        state: State {
            request: 7,
            surface: if session {
                Surface::Workspace
            } else {
                Surface::Home
            },
            home_phase: HomePhase::Live,
            ..State::default()
        },
        targets: BTreeMap::new(),
        stage: None,
        submitted: false,
        window_notice: None,
        active: session.then(|| Route {
            id: "route".into(),
            request: 7,
            target: target(),
            workspace: "fixture".into(),
            window: None,
            notice: None,
            window_panes: Vec::new(),
        }),
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
        flap: Default::default(),
        empty_open: Default::default(),
        home: Default::default(),
        background_fleet: Default::default(),
        registry: Default::default(),
        preferences: Default::default(),
        navigation: Default::default(),
        registry_worker: Some(CatalogWorker::spawn(path.clone()).unwrap()),
        registry_dirty: false,
        local_record: Some(path.clone()),
        sources: NativeOwner::new(CatalogSource::Local(path)),
        selected_profile: None,
        resume: None,
    };
    (local, receiver)
}
pub(in crate::tmux_snapshot) fn presence(local: &mut Local, active: bool) {
    let revision = local.presence_revision + 1;
    local
        .command(Command::Presence { active, revision })
        .unwrap();
}
