#![allow(clippy::unwrap_used)]
//! A harness stops the scratch daemon when the outage file appears, then restarts it.
use super::*;
const RECONNECTING: &str = "Connection lost. Reconnecting…";
const GIVE_UP: &str = "Couldn't reconnect. Refresh sessions to try again.";
fn connected(bridge: &Bridge) -> (State, PathBuf) {
    let outage = std::env::var_os("TMUX_IDE_TEST_RESTART_OUTAGE").unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut opened = None;
    while Instant::now() < deadline {
        if let Some(state) = bridge.mailbox.lock().unwrap().take() {
            let state = state.unwrap_or_else(|| panic!("native browser closed"));
            match opened {
                None if state.home_phase == HomePhase::Live
                    && state.session_catalog_complete
                    && !state.sessions.is_empty() =>
                {
                    let request = state.request + 1;
                    bridge
                        .commands
                        .send(Command::Session {
                            request,
                            id: state.sessions[0].id.clone(),
                        })
                        .unwrap();
                    opened = Some(request);
                }
                Some(request)
                    if state.request == request && state.frame.is_some() && state.input_ready =>
                {
                    return (state, outage.into());
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("session never connected");
}
/// Every state until `done` returns true; the bridge receives no command meanwhile.
fn observe(
    bridge: &Bridge,
    limit: Duration,
    done: impl Fn(&State) -> bool,
) -> Vec<(Duration, State)> {
    let started = Instant::now();
    let mut seen = Vec::new();
    while started.elapsed() < limit {
        if let Some(state) = bridge.mailbox.lock().unwrap().take() {
            let state = state.unwrap_or_else(|| panic!("native browser closed"));
            let stop = done(&state);
            seen.push((started.elapsed(), state));
            if stop {
                return seen;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    seen
}
fn statuses(seen: &[(Duration, State)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (at, state) in seen {
        let line = format!("{:.1}s {}", at.as_secs_f32(), state.status);
        if out.last().is_none_or(|last| !last.ends_with(&state.status)) {
            out.push(line);
        }
    }
    out
}
#[test]
#[ignore = "requires a scratch daemon the harness stops for about 7 s"]
fn session_reconnects_on_its_own_after_a_short_daemon_outage() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let (live, outage) = connected(&bridge);
    std::fs::write(&outage, b"stop").unwrap();
    let lost = std::cell::Cell::new(false);
    let seen = observe(&bridge, Duration::from_secs(30), |s| {
        lost.set(lost.get() || !s.input_ready);
        lost.get() && s.request == live.request && s.frame.is_some() && s.input_ready
    });
    let trail = statuses(&seen);
    let last = &seen.last().unwrap().1;
    assert!(
        last.frame.is_some() && last.input_ready,
        "no reconnect: {trail:?}"
    );
    assert_eq!(last.selected_session, live.selected_session, "{trail:?}");
    assert_eq!(last.selected_pane, live.selected_pane, "{trail:?}");
    assert!(
        seen.iter().any(|(_, s)| s.status == RECONNECTING),
        "{trail:?}"
    );
    assert!(!seen.iter().any(|(_, s)| s.status == GIVE_UP), "{trail:?}");
    assert!(
        seen.last().unwrap().0 > Duration::from_secs(4),
        "outage too short: {trail:?}"
    );
    eprintln!("RESTART_LIVE {trail:?}");
    owner.shutdown().unwrap();
}
#[test]
#[ignore = "requires a scratch daemon the harness stops for longer than 30 s"]
fn session_ends_on_the_refresh_message_after_a_long_daemon_outage() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let (_, outage) = connected(&bridge);
    std::fs::write(&outage, b"stop").unwrap();
    let seen = observe(&bridge, Duration::from_secs(40), |s| s.status == GIVE_UP);
    let trail = statuses(&seen);
    let (gave_up_at, last) = seen.last().unwrap();
    assert_eq!(last.status, GIVE_UP, "{trail:?}");
    assert!(
        *gave_up_at > Duration::from_secs(20) && *gave_up_at < Duration::from_secs(35),
        "{trail:?}"
    );
    // While waiting, only the reconnect status and the retry's own catalog loads appear.
    for (_, state) in seen[..seen.len() - 1]
        .iter()
        .filter(|(_, s)| !s.input_ready)
    {
        assert!(
            [RECONNECTING, "Loading sessions"].contains(&state.status.as_str())
                || state.status == "Terminal connection interrupted — recovering",
            "{trail:?}"
        );
    }
    let after = observe(&bridge, Duration::from_secs(5), |_| false);
    assert!(
        after.iter().all(|(_, s)| s.status == GIVE_UP),
        "{:?}",
        statuses(&after)
    );
    eprintln!("RESTART_LIVE {trail:?}");
    owner.shutdown().unwrap();
}
