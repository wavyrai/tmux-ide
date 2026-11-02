#![allow(clippy::unwrap_used)]
//! Card #702, live: a harness freezes the scratch daemon for 10 s, resumes it,
//! then restarts it, signalling each step through files. The frame must stay on
//! screen throughout and typing must work after each step without reselecting.
use super::*;
use crate::tmux_snapshot::keys::Input;

fn next(bridge: &Bridge) -> Option<State> {
    bridge
        .mailbox
        .lock()
        .unwrap()
        .take()
        .map(|state| state.unwrap_or_else(|| panic!("native browser closed")))
}
fn contains(state: &State, needle: &str) -> bool {
    state.frame.as_ref().is_some_and(|frame| {
        let view = frame.view();
        (0..usize::from(view.height())).any(|y| {
            view.row(y).is_some_and(|cells| {
                cells
                    .iter()
                    .map(|cell| cell.symbol.as_str())
                    .collect::<String>()
                    .contains(needle)
            })
        })
    })
}
#[derive(Default)]
struct Watch {
    seen: Vec<String>,
    frameless: Vec<String>,
    max_attempt: u32,
    lost_at: Option<u64>,
    reconnect_requests: Vec<u64>,
    reconnect_paths: Vec<Vec<String>>,
    /// Lines retyped after the app reported them lost with a dropped stream.
    retyped: Vec<String>,
}
impl Watch {
    /// Every publication of the session's request must carry a frame.
    fn observe(&mut self, state: &State, request: u64, started: Instant) {
        let at = format!("{:.1}s {}", started.elapsed().as_secs_f32(), state.status);
        if self.seen.last() != Some(&at)
            && self.seen.last().is_none_or(|l| !l.ends_with(&state.status))
        {
            self.seen.push(at.clone());
        }
        if state.request == request && state.frame.is_none() {
            self.frameless.push(at);
        }
        if let Some(attempt) = state.reconnect_attempt {
            self.max_attempt = self.max_attempt.max(attempt);
            self.lost_at
                .get_or_insert_with(herdr_client::tmux_daemon::requests_sent);
        } else if state.input_ready
            && let Some(lost) = self.lost_at.take()
        {
            self.reconnect_requests
                .push(herdr_client::tmux_daemon::requests_sent() - lost);
            self.reconnect_paths
                .push(herdr_client::tmux_daemon::requests_since(lost));
        }
    }
}
fn until(
    bridge: &Bridge,
    watch: &mut Watch,
    request: u64,
    limit: Duration,
    done: impl Fn(&State) -> bool,
) -> State {
    let started = Instant::now();
    // An idle app publishes nothing (#703), so a condition that becomes true
    // outside the app (a harness signal) is re-checked against the last state.
    let mut last: Option<State> = None;
    loop {
        assert!(
            started.elapsed() < limit,
            "timed out: {:?}; last: {:?}",
            watch.seen,
            last.as_ref().map(|s| (
                s.request,
                s.input_ready,
                s.frame.is_some(),
                s.retained_preview,
                s.reconnect_attempt,
                s.status.clone(),
                s.input_targets.len(),
            ))
        );
        if let Some(state) = next(bridge) {
            watch.observe(&state, request, started);
            if done(&state) {
                return state;
            }
            last = Some(state);
        } else if last.as_ref().is_some_and(&done) {
            return last.take().unwrap();
        } else {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
fn send_line(bridge: &Bridge, state: &State, marker: &str) {
    let pane = state.selected_pane.clone().unwrap();
    let target = state
        .input_targets
        .iter()
        .find(|target| target.id == pane)
        .unwrap()
        .token
        .clone();
    for input in [
        Input::Text(format!("printf 'typed-%s\\n' {marker}")),
        Input::Key("Enter".into()),
    ] {
        bridge
            .commands
            .send(Command::Input {
                request: state.request,
                id: pane.clone(),
                input_target: Some(target.clone()),
                input,
            })
            .unwrap();
    }
}
/// Type a line and wait for its output. Keys typed in the instant before a drop
/// are lost with the stream and never replayed; then the app must have said so
/// (the lost-keys notice), and the line is retyped once after the reconnect,
/// as the notice asks. Silent loss fails the test.
fn type_line(bridge: &Bridge, watch: &mut Watch, state: &State, marker: &str) -> State {
    send_line(bridge, state, marker);
    let needle = format!("typed-{marker}");
    let told = std::cell::Cell::new(false);
    let dropped = std::cell::Cell::new(false);
    let settled = until(bridge, watch, state.request, Duration::from_secs(30), |s| {
        told.set(told.get() || s.status.contains(hold::LOST_INPUT));
        dropped.set(dropped.get() || s.reconnect_attempt.is_some());
        (s.input_ready && contains(s, &needle))
            || (dropped.get() && s.input_ready && s.reconnect_attempt.is_none())
    });
    if contains(&settled, &needle) {
        return settled;
    }
    assert!(told.get(), "typed keys were lost without a notice");
    watch.retyped.push(marker.to_owned());
    send_line(bridge, &settled, marker);
    until(bridge, watch, state.request, Duration::from_secs(15), |s| {
        s.input_ready && contains(s, &needle)
    })
}
fn signalled(name: &str) -> bool {
    let dir = std::env::var_os("TMUX_IDE_TEST_SIGNAL_DIR").unwrap();
    PathBuf::from(dir).join(name).exists()
}
#[test]
#[ignore = "requires a scratch daemon the harness freezes and restarts"]
fn a_lost_stream_rebinds_keeping_the_frame_and_typing_works_after() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let mut watch = Watch::default();
    let home = until(
        &bridge,
        &mut watch,
        u64::MAX,
        Duration::from_secs(30),
        |s| s.home_phase == HomePhase::Live && s.session_catalog_complete && !s.sessions.is_empty(),
    );
    let request = home.request + 1;
    bridge
        .commands
        .send(Command::Session {
            request,
            id: home.sessions[0].id.clone(),
        })
        .unwrap();
    let live = until(
        &bridge,
        &mut watch,
        u64::MAX,
        Duration::from_secs(30),
        |s| s.request == request && s.frame.is_some() && s.input_ready,
    );
    let live = type_line(&bridge, &mut watch, &live, "one");

    // Same daemon: the harness ends the terminal source, the stream drops, and
    // the app re-issues a lease for the same session.
    eprintln!("RECONNECT_DROP_READY");
    let lost = std::cell::Cell::new(false);
    let rebound = until(&bridge, &mut watch, request, Duration::from_secs(60), |s| {
        lost.set(lost.get() || s.reconnect_attempt.is_some());
        lost.get() && s.input_ready && s.frame.is_some() && s.reconnect_attempt.is_none()
    });
    assert_eq!(rebound.selected_session, live.selected_session);
    let live = type_line(&bridge, &mut watch, &rebound, "rebound");

    eprintln!("RECONNECT_STOP_READY");
    let resumed = until(&bridge, &mut watch, request, Duration::from_secs(90), |s| {
        signalled("stop-done") && s.input_ready && s.frame.is_some()
    });
    assert_eq!(resumed.selected_session, live.selected_session);
    let resumed = type_line(&bridge, &mut watch, &resumed, "two");

    eprintln!("RECONNECT_RESTART_READY");
    let restarted = until(&bridge, &mut watch, request, Duration::from_secs(90), |s| {
        signalled("restart-done")
            && s.input_ready
            && s.frame.is_some()
            && s.reconnect_attempt.is_none()
    });
    assert_eq!(restarted.selected_session, resumed.selected_session);
    assert_eq!(restarted.request, request, "the app navigated away");
    type_line(&bridge, &mut watch, &restarted, "three");

    eprintln!(
        "RECONNECT_LIVE {}",
        serde_json::json!({
            "frameless": watch.frameless,
            "maxAttempt": watch.max_attempt,
            "requestsPerReconnect": watch.reconnect_requests,
            "requestPaths": watch.reconnect_paths,
            "retyped": watch.retyped,
            "trail": watch.seen,
        })
    );
    assert!(
        watch.frameless.is_empty(),
        "frame dropped: {:?}",
        watch.frameless
    );
    owner.shutdown().unwrap();
}
