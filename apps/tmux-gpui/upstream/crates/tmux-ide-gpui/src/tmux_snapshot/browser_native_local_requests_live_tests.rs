//! Daemon requests the app sends for three things a user does: open a
//! session, sit in it for a minute, create a session. The harness
//! (bridge/manual/native-connection-soak.mjs, `SOAK_MODE=requests`) owns the
//! scratch daemon and tmux server and prints the line this test writes.
//! `GET /api/v1/tmux-servers` is counted on its own: on a 2.9.22 daemon every
//! one of them probed each tmux server, and a slow probe closed every stream.
use super::*;
use std::collections::BTreeMap;

/// Requests by masked path since the last call, and their order.
struct Tally(u64, Vec<String>);
impl Tally {
    fn start() -> Self {
        Self(herdr_client::tmux_daemon::requests_sent(), Vec::new())
    }
    fn drain(&mut self, into: &mut BTreeMap<String, u64>) {
        for path in herdr_client::tmux_daemon::requests_since(self.0) {
            *into.entry(path.clone()).or_default() += 1;
            let short = path.rsplit('/').find(|part| *part != ":").unwrap_or("");
            self.1.push(short.to_owned());
        }
        self.0 = herdr_client::tmux_daemon::requests_sent();
    }
    /// The last path segment of each request since the last call, in order.
    fn order(&mut self) -> String {
        std::mem::take(&mut self.1).join(" ")
    }
}
/// Runs until `done` or `quiet` has passed with `done` unset, tallying.
fn phase(
    bridge: &Bridge,
    tally: &mut Tally,
    last: &mut Option<State>,
    limit: Duration,
    done: impl Fn(&State) -> bool,
) -> serde_json::Value {
    let started = Instant::now();
    let mut paths = BTreeMap::new();
    let mut finished = None;
    loop {
        if let Some(state) = next(bridge) {
            *last = Some(state);
        }
        tally.drain(&mut paths);
        if finished.is_none() && last.as_ref().is_some_and(&done) {
            finished = Some(Instant::now());
        }
        // Two quiet seconds after the goal: what the action set off is counted.
        if finished.is_some_and(|at| at.elapsed() >= Duration::from_secs(2)) {
            break;
        }
        assert!(
            finished.is_some() || started.elapsed() < limit,
            "timed out: {:?}",
            last.as_ref()
                .map(|s| (&s.status, s.surface == Surface::Home))
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    serde_json::json!({
        "total": paths.values().sum::<u64>(),
        "tmuxServers": paths.get("/api/:/tmux-servers").copied().unwrap_or(0),
        "ms": finished.map_or(0, |at| at.duration_since(started).as_millis() as u64),
        "paths": paths,
        "order": tally.order(),
    })
}

#[test]
#[ignore = "requires the connection soak harness in requests mode"]
fn connection_request_counts() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let idle = std::env::var("TMUX_IDE_TEST_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60u64);
    let mut tally = Tally::start();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let mut last = None;
    let live_home = |s: &State| {
        s.surface == Surface::Home
            && s.home_phase == HomePhase::Live
            && s.session_catalog_complete
            && !s.sessions.is_empty()
    };
    let limit = Duration::from_secs(45);
    let home = phase(&bridge, &mut tally, &mut last, limit, live_home);
    let state = last.clone().unwrap();
    let request = state.request + 1;
    bridge
        .commands
        .send(Command::Session {
            request,
            id: state.sessions[0].id.clone(),
        })
        .unwrap();
    let attached = move |request: u64| {
        move |s: &State| {
            s.request == request
                && s.surface == Surface::Workspace
                && s.frame.is_some()
                && !s.retained_preview
                && s.input_ready
        }
    };
    let open = phase(&bridge, &mut tally, &mut last, limit, attached(request));
    // A minute in the open session, typing nothing.
    let mut idle_paths = BTreeMap::new();
    let idle_started = Instant::now();
    while idle_started.elapsed() < Duration::from_secs(idle) {
        if let Some(state) = next(&bridge) {
            last = Some(state);
        }
        tally.drain(&mut idle_paths);
        std::thread::sleep(Duration::from_millis(50));
    }
    tally.order();
    let still = last.as_ref().unwrap();
    assert!(attached(request)(still), "the session dropped while idle");
    // Home again, pick the session's server, create a session on it.
    let request = request + 1;
    bridge.commands.send(Command::Home { request }).unwrap();
    let back = phase(&bridge, &mut tally, &mut last, limit, move |s| {
        s.request == request && live_home(s)
    });
    let state = last.clone().unwrap();
    let server = state.fleet.as_ref().unwrap().groups[0].servers[0].clone();
    let request = request + 1;
    bridge
        .commands
        .send(Command::FleetServer {
            request,
            selection: server.selection.unwrap(),
        })
        .unwrap();
    let select = phase(&bridge, &mut tally, &mut last, limit, move |s| {
        s.request == request
            && s.home_phase == HomePhase::Live
            && (s.create_session.as_ref()).is_some_and(|c| c.phase == CreatePhase::Idle)
    });
    bridge
        .commands
        .send(Command::CreateSession {
            request,
            name: "soak-created".into(),
        })
        .unwrap();
    let create = phase(&bridge, &mut tally, &mut last, limit, attached(request));
    eprintln!(
        "REQUEST_COUNTS {}",
        serde_json::json!({
            "home": home,
            "openSession": open,
            "idle": {
                "secs": idle,
                "total": idle_paths.values().sum::<u64>(),
                "tmuxServers": idle_paths.get("/api/:/tmux-servers").copied().unwrap_or(0),
                "paths": idle_paths,
            },
            "backToHome": back,
            "selectServer": select,
            "createSession": create,
        })
    );
    owner.shutdown().unwrap();
}
