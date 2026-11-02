#![allow(clippy::unwrap_used)]
//! Card #703, live: daemon requests before Home, and requests and publications
//! while Home sits idle for a minute, against a scratch daemon.
use super::*;

#[test]
#[ignore = "requires a scratch daemon with sessions"]
fn home_loads_with_few_requests_and_stays_quiet_when_idle() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let idle = std::env::var("TMUX_IDE_TEST_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60u64);
    let start_requests = herdr_client::tmux_daemon::requests_sent();
    let started = Instant::now();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let home = loop {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "Home never loaded"
        );
        let state = bridge.mailbox.lock().unwrap().take();
        match state {
            Some(Some(state))
                if state.home_phase == HomePhase::Live
                    && state.session_catalog_complete
                    && !state.sessions.is_empty() =>
            {
                break state;
            }
            Some(None) => panic!("native browser closed"),
            _ => std::thread::sleep(Duration::from_millis(5)),
        }
    };
    let home_ms = started.elapsed().as_millis();
    eprintln!("HOME_PROGRESS home at {home_ms} ms");
    let at_home = herdr_client::tmux_daemon::requests_sent();
    let before_home = herdr_client::tmux_daemon::requests_since(start_requests);
    // Let startup settle, then watch an idle Home.
    std::thread::sleep(Duration::from_secs(3));
    let settled = herdr_client::tmux_daemon::requests_sent();
    eprintln!("HOME_PROGRESS settled");
    while bridge.mailbox.lock().unwrap().take().is_some() {}
    eprintln!("HOME_PROGRESS idle starts");
    let idle_started = Instant::now();
    let mut reported = 0;
    let mut publications = 0u64;
    while idle_started.elapsed() < Duration::from_secs(idle) {
        let state = bridge.mailbox.lock().unwrap().take();
        if let Some(state) = state {
            assert!(state.is_some(), "native browser closed");
            publications += 1;
        }
        std::thread::sleep(Duration::from_millis(5));
        let secs = idle_started.elapsed().as_secs();
        if secs >= reported + 10 {
            reported = secs;
            eprintln!(
                "HOME_PROGRESS idle {secs} s, requests {}",
                herdr_client::tmux_daemon::requests_sent() - settled
            );
        }
    }
    let idle_requests = herdr_client::tmux_daemon::requests_sent() - settled;
    eprintln!(
        "HOME_LIVE {}",
        serde_json::json!({
            "homeMs": home_ms,
            "sessions": home.sessions.len(),
            "requestsBeforeHome": at_home - start_requests,
            "pathsBeforeHome": before_home,
            "settleRequests": settled - at_home,
            "idleSecs": idle,
            "idleRequests": idle_requests,
            "idlePaths": herdr_client::tmux_daemon::requests_since(settled),
            "idlePublications": publications,
        })
    );
    owner.shutdown().unwrap();
}

fn until_state(
    bridge: &Bridge,
    step: &str,
    limit: Duration,
    done: impl Fn(&State) -> bool,
) -> State {
    let started = Instant::now();
    let mut last: Option<State> = None;
    loop {
        assert!(
            started.elapsed() < limit,
            "timed out at {step}; last: {:?}",
            last.as_ref().map(|s| (
                s.request,
                s.home_phase,
                s.session_catalog_complete,
                s.sessions.len(),
                s.status.clone()
            ))
        );
        // Release the lock before sleeping: the transport waits on it, and
        // holding it across the sleep delayed Session → Home by seconds.
        let taken = bridge.mailbox.lock().unwrap().take();
        match taken {
            Some(Some(state)) if done(&state) => return state,
            Some(Some(state)) => last = Some(state),
            Some(None) => panic!("native browser closed"),
            None if last.as_ref().is_some_and(&done) => return last.take().unwrap(),
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    }
}

/// Card #703 (PM): Session → Home costs at most 3 requests. Opens a session,
/// lets it settle, goes Home, and counts the requests until Home is live and
/// for 3 s after.
#[test]
#[ignore = "requires a scratch daemon with sessions"]
fn session_to_home_costs_few_requests() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let home_live = |s: &State| {
        s.home_phase == HomePhase::Live && s.session_catalog_complete && !s.sessions.is_empty()
    };
    let home = until_state(&bridge, "first Home", Duration::from_secs(30), home_live);
    let request = home.request + 1;
    bridge
        .commands
        .send(Command::Session {
            request,
            id: home.sessions[0].id.clone(),
        })
        .unwrap();
    until_state(&bridge, "session", Duration::from_secs(30), |s| {
        s.request == request && s.frame.is_some() && s.input_ready
    });
    std::thread::sleep(Duration::from_secs(3));
    while bridge.mailbox.lock().unwrap().take().is_some() {}
    let before = herdr_client::tmux_daemon::requests_sent();
    let started = Instant::now();
    bridge
        .commands
        .send(Command::Home {
            request: request + 1,
        })
        .unwrap();
    until_state(&bridge, "Session → Home", Duration::from_secs(30), |s| {
        s.request == request + 1 && home_live(s)
    });
    let home_ms = started.elapsed().as_millis();
    let at_home = herdr_client::tmux_daemon::requests_sent();
    let paths_at_home = herdr_client::tmux_daemon::requests_since(before);
    std::thread::sleep(Duration::from_secs(3));
    eprintln!(
        "HOME_LIVE {}",
        serde_json::json!({
            "sessionToHomeMs": home_ms,
            "requestsUntilHome": at_home - before,
            "pathsUntilHome": paths_at_home,
            "requestsWithin3s": herdr_client::tmux_daemon::requests_sent() - before,
            "pathsWithin3s": herdr_client::tmux_daemon::requests_since(before),
        })
    );
    owner.shutdown().unwrap();
}
