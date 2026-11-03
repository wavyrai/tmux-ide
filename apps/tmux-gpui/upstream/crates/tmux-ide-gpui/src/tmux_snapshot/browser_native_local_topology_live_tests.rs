#![allow(clippy::unwrap_used)]
//! Live: a pane is split into the viewed session from outside the app (another
//! tmux client). The stream must take the new pane without dropping, or at
//! worst re-lease once and continue. The harness splits after
//! `TOPOLOGY_SPLIT_READY` and writes `split-done`.
use super::*;
use crate::tmux_snapshot::keys::Input;

fn take(bridge: &Bridge) -> Option<State> {
    let taken = bridge.mailbox.lock().unwrap().take();
    taken.map(|state| state.unwrap_or_else(|| panic!("native browser closed")))
}
fn until(bridge: &Bridge, label: &str, limit: Duration, done: impl Fn(&State) -> bool) -> State {
    let started = Instant::now();
    let mut last: Option<State> = None;
    loop {
        assert!(started.elapsed() < limit, "timed out at {label}");
        match take(bridge) {
            Some(s) if done(&s) => return s,
            Some(s) => last = Some(s),
            None if last.as_ref().is_some_and(&done) => return last.take().unwrap(),
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    }
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
/// Type a line into the selected pane after the split, as the owner would.
fn type_line(bridge: &Bridge, state: &State) -> bool {
    let pane = state.selected_pane.clone().unwrap();
    let Some(target) = state.input_targets.iter().find(|t| t.id == pane) else {
        return false;
    };
    for input in [
        Input::Text("printf 'typed-%s\\n' after-split".into()),
        Input::Key("Enter".into()),
    ] {
        bridge
            .commands
            .send(Command::Input {
                request: state.request,
                id: pane.clone(),
                input_target: Some(target.token.clone()),
                input,
            })
            .unwrap();
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if take(bridge).is_some_and(|s| contains(&s, "typed-after-split")) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

#[test]
#[ignore = "requires a scratch daemon and a harness that splits a pane"]
fn a_pane_split_in_from_outside_joins_the_open_stream() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let signals = PathBuf::from(std::env::var_os("TMUX_IDE_TEST_SIGNAL_DIR").unwrap());
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let home = until(&bridge, "Home", Duration::from_secs(30), |s| {
        s.home_phase == HomePhase::Live && s.session_catalog_complete && !s.sessions.is_empty()
    });
    let request = home.request + 1;
    bridge
        .commands
        .send(Command::Session {
            request,
            id: home.sessions[0].id.clone(),
        })
        .unwrap();
    let live = until(&bridge, "session", Duration::from_secs(30), |s| {
        s.request == request && s.frame.is_some() && s.input_ready && !s.panes.is_empty()
    });
    let before = live.panes.len();
    eprintln!(
        "TOPOLOGY_SPLIT_READY {}",
        live.selected_pane.clone().unwrap_or_default()
    );
    let started = Instant::now();
    let (mut trail, mut max_attempt, mut split_at) = (Vec::<String>::new(), 0u32, None);
    let (mut recovered, mut typed) = (None, false);
    while started.elapsed() < Duration::from_secs(60) {
        if split_at.is_none() && signals.join("split-done").exists() {
            split_at = Some(started.elapsed().as_millis());
        }
        if let Some(s) = take(&bridge) {
            max_attempt = max_attempt.max(s.reconnect_attempt.unwrap_or(0));
            let line = format!(
                "{} ms r={} panes={} ready={} attempt={:?} {}",
                started.elapsed().as_millis(),
                s.request,
                s.panes.len(),
                s.input_ready,
                s.reconnect_attempt,
                s.status.chars().take(80).collect::<String>()
            );
            if trail
                .last()
                .is_none_or(|l| l.split_once(' ').map(|x| x.1) != line.split_once(' ').map(|x| x.1))
            {
                trail.push(line);
            }
            if split_at.is_some()
                && s.request == request
                && s.input_ready
                && s.reconnect_attempt.is_none()
                && s.panes.len() == before + 1
            {
                recovered = Some(started.elapsed().as_millis());
                typed = type_line(&bridge, &s);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    eprintln!(
        "TOPOLOGY_LIVE {}",
        serde_json::json!({
            "panesBefore": before,
            "splitAtMs": split_at,
            "recoveredAtMs": recovered,
            "maxAttempt": max_attempt,
            "typedAfterSplit": typed,
            "trail": trail,
        })
    );
    owner.shutdown().unwrap();
    assert!(recovered.is_some(), "the stream never took the split pane");
    assert!(typed, "typing did not land after the split");
}
