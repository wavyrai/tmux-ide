#![allow(clippy::unwrap_used)]
//! Live (card #720): a pane is split into the viewed session from another tmux
//! client, then closed again. The stream must carry on each time, keeping its
//! frame, and typing must land after each change. The harness splits after
//! `TOPOLOGY_SPLIT_READY` and closes after `TOPOLOGY_CLOSE_READY`, writing
//! `split-done` and `close-done`.
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
    use std::sync::atomic::{AtomicU32, Ordering};
    static TYPED: AtomicU32 = AtomicU32::new(0);
    let marker = format!("after-change-{}", TYPED.fetch_add(1, Ordering::Relaxed));
    let pane = state.selected_pane.clone().unwrap();
    let Some(target) = state.input_targets.iter().find(|t| t.id == pane) else {
        return false;
    };
    for input in [
        Input::Text(format!("printf 'typed-%s\\n' {marker}")),
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
        if take(bridge).is_some_and(|s| contains(&s, &format!("typed-{marker}"))) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

/// Wait for the session to show `panes` panes, ready and not reconnecting.
/// Records each distinct state, and any publication of this request without a
/// frame (the existing panes must keep their frames).
fn settle(
    bridge: &Bridge,
    request: u64,
    panes: usize,
    signal: &std::path::Path,
) -> (Option<u128>, Option<State>, serde_json::Value) {
    let started = Instant::now();
    let (mut trail, mut frameless, mut max_attempt, mut signalled) =
        (Vec::<String>::new(), 0u64, 0u32, None);
    while started.elapsed() < Duration::from_secs(60) {
        if signalled.is_none() && signal.exists() {
            signalled = Some(started.elapsed().as_millis());
        }
        if let Some(s) = take(bridge) {
            max_attempt = max_attempt.max(s.reconnect_attempt.unwrap_or(0));
            if s.request == request && s.frame.is_none() {
                frameless += 1;
            }
            let line = format!(
                "r={} panes={} frame={} ready={} attempt={:?} {}",
                s.request,
                s.panes.len(),
                s.frame.is_some(),
                s.input_ready,
                s.reconnect_attempt,
                s.status.chars().take(80).collect::<String>()
            );
            if trail
                .last()
                .is_none_or(|l: &String| l.split_once(' ').map(|x| x.1) != Some(line.as_str()))
            {
                trail.push(format!("{} ms {line}", started.elapsed().as_millis()));
            }
            if signalled.is_some()
                && s.request == request
                && s.input_ready
                && s.reconnect_attempt.is_none()
                && s.panes.len() == panes
            {
                let at = started.elapsed().as_millis();
                let report = serde_json::json!({
                    "signalledAtMs": signalled, "settledAtMs": at, "maxAttempt": max_attempt,
                    "frameless": frameless, "trail": trail,
                });
                return (Some(at), Some(s), report);
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let report = serde_json::json!({
        "signalledAtMs": signalled, "settledAtMs": null, "maxAttempt": max_attempt,
        "frameless": frameless, "trail": trail,
    });
    (None, None, report)
}

#[test]
#[ignore = "requires a scratch daemon and a harness that splits and closes a pane"]
fn a_pane_split_in_or_closed_from_outside_keeps_the_open_stream() {
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
    eprintln!("TOPOLOGY_SPLIT_READY");
    let (split, after_split, split_report) =
        settle(&bridge, request, before + 1, &signals.join("split-done"));
    let split_typed = after_split.as_ref().is_some_and(|s| type_line(&bridge, s));
    eprintln!("TOPOLOGY_CLOSE_READY");
    let (close, after_close, close_report) = if split.is_some() {
        settle(&bridge, request, before, &signals.join("close-done"))
    } else {
        (None, None, serde_json::Value::Null)
    };
    let close_typed = after_close.as_ref().is_some_and(|s| type_line(&bridge, s));
    eprintln!(
        "TOPOLOGY_LIVE {}",
        serde_json::json!({
            "panesBefore": before,
            "split": split_report, "typedAfterSplit": split_typed,
            "close": close_report, "typedAfterClose": close_typed,
        })
    );
    owner.shutdown().unwrap();
    assert!(
        split.is_some() && split_typed,
        "the stream did not carry on after a split"
    );
    assert!(
        close.is_some() && close_typed,
        "the stream did not carry on after a close"
    );
    // Review #720 N1: the existing panes keep their frames throughout.
    for (phase, report) in [("split", &split_report), ("close", &close_report)] {
        assert_eq!(
            report["frameless"], 0,
            "{phase}: a publication dropped the frame"
        );
    }
}

/// The selected pane is replaced from outside: another client splits a new
/// pane in, then kills the selected one. The stream must move to the pane that
/// remains, not keep reconnecting to the one that is gone.
#[test]
#[ignore = "requires a scratch daemon and a harness that replaces the selected pane"]
fn the_selected_pane_replaced_from_outside_moves_to_the_pane_left() {
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
    let original = live.selected_pane.clone().unwrap();
    eprintln!("TOPOLOGY_REPLACE_READY");
    let (replaced, after, report) = settle(&bridge, request, 1, &signals.join("replace-done"));
    let moved = after
        .as_ref()
        .is_some_and(|s| s.selected_pane.as_deref() != Some(original.as_str()));
    let typed = after
        .as_ref()
        .is_some_and(|s| moved && type_line(&bridge, s));
    eprintln!(
        "TOPOLOGY_LIVE {}",
        serde_json::json!({"replace": report, "moved": moved, "typedAfterReplace": typed})
    );
    owner.shutdown().unwrap();
    assert!(
        replaced.is_some() && moved,
        "the stream stayed on the replaced pane"
    );
    assert!(typed, "typing did not land in the remaining pane");
    assert_eq!(report["frameless"], 0, "a publication dropped the frame");
}
