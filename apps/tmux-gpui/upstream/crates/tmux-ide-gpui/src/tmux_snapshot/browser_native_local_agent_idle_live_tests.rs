#![allow(clippy::unwrap_used)]
//! Card #716, live: with 2 agents on an isolated daemon, the agent rows on Home
//! and in an open session stay still and cost no agent requests while nothing
//! changes, and a state flip shows within 1 s without the rows blinking. The
//! harness flips "Fixture agent A" after each `AGENT_FLIP_READY <phase>`.
use super::*;
use crate::tmux_snapshot::browser::home_agents::{Phase, Roster};

type View = Option<(Phase, Vec<String>, u64)>;
/// What the user sees of a roster; the revision counter is not shown.
fn view(roster: Option<&Roster>) -> View {
    roster.map(|r| {
        (
            r.phase.clone(),
            r.rows
                .iter()
                .map(|row| {
                    format!(
                        "{}|{}|{}|{}",
                        row.name,
                        row.status.label(),
                        row.attention,
                        row.available
                    )
                })
                .collect(),
            r.observed_sessions,
        )
    })
}
fn home_view(s: &State) -> View {
    view(s.home_agents.as_ref())
}
fn session_view(s: &State) -> View {
    view(s.workspace_agents.as_ref().map(|w| &w.roster))
}
fn take(bridge: &Bridge) -> Option<State> {
    // Take in a `let` so the lock is not held while the caller sleeps.
    let taken = bridge.mailbox.lock().unwrap().take();
    taken.map(|state| state.unwrap_or_else(|| panic!("native browser closed")))
}
fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
}
fn until(bridge: &Bridge, label: &str, done: impl Fn(&State) -> bool) -> State {
    let started = Instant::now();
    let mut last: Option<State> = None;
    loop {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "timed out at {label}"
        );
        match take(bridge) {
            Some(s) if done(&s) => return s,
            Some(s) => last = Some(s),
            None if last.as_ref().is_some_and(&done) => return last.take().unwrap(),
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    }
}
/// Watch an idle screen: daemon requests, publications and visible changes.
fn idle(bridge: &Bridge, secs: u64, shown: View, see: fn(&State) -> View) -> serde_json::Value {
    let requests = herdr_client::tmux_daemon::requests_sent();
    let started = Instant::now();
    let (mut publications, mut changes, mut current) = (0u64, Vec::new(), shown);
    while started.elapsed() < Duration::from_secs(secs) {
        if let Some(s) = take(bridge) {
            publications += 1;
            let seen = see(&s);
            if seen != current {
                changes.push(format!(
                    "{} ms: {:?}",
                    started.elapsed().as_millis(),
                    seen.as_ref().map(|v| (&v.1, v.2))
                ));
                current = seen;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    serde_json::json!({
        "requests": herdr_client::tmux_daemon::requests_sent() - requests,
        "paths": herdr_client::tmux_daemon::requests_since(requests),
        "publications": publications,
        "changes": changes,
    })
}
/// Ask the harness to flip agent A to `status`; time until it shows, and list
/// anything else shown on the way (a blink).
fn flip(
    bridge: &Bridge,
    phase: &str,
    signals: &std::path::Path,
    status: &str,
    see: fn(&State) -> View,
) -> serde_json::Value {
    eprintln!("AGENT_FLIP_READY {phase}");
    let target = format!("Fixture agent A|{status}|");
    let started = Instant::now();
    let mut between = Vec::new();
    // The first request after the flip is the app's re-read on the daemon's
    // notice: before it, the time is the daemon's detection.
    let base = herdr_client::tmux_daemon::requests_sent();
    let mut first_request = None;
    loop {
        if first_request.is_none() && herdr_client::tmux_daemon::requests_sent() > base {
            first_request = Some(epoch_ms());
        }
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "the {phase} flip never showed"
        );
        if let Some(s) = take(bridge) {
            let seen = see(&s);
            let rows = seen.as_ref().map(|v| v.1.clone()).unwrap_or_default();
            if rows.iter().any(|r| r.starts_with(&target)) {
                let at = std::fs::read_to_string(signals.join(format!("flipped-{phase}"))).unwrap();
                let at = at.trim().parse::<u128>().unwrap();
                return serde_json::json!({
                    "ms": epoch_ms() - at,
                    "notifiedMs": first_request.map(|first| first.saturating_sub(at)),
                    "paths": herdr_client::tmux_daemon::requests_since(base),
                    "between": between,
                });
            }
            between.push(format!("{:?}", seen.as_ref().map(|v| (&v.1, v.2))));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "requires a scratch daemon with 2 hook-stamped agents"]
fn agent_rows_stay_still_when_idle_and_show_a_flip_within_a_second() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let signals = PathBuf::from(std::env::var_os("TMUX_IDE_TEST_SIGNAL_DIR").unwrap());
    let secs = std::env::var("TMUX_IDE_TEST_IDLE_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60u64);
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let home = until(&bridge, "Home agents", |s| {
        s.home_phase == HomePhase::Live && home_view(s).is_some_and(|v| v.1.len() >= 2)
    });
    std::thread::sleep(Duration::from_secs(5));
    let mut shown = home_view(&home);
    while let Some(s) = take(&bridge) {
        shown = home_view(&s);
    }
    let home_rows = shown.clone().unwrap().1;
    eprintln!("AGENT_HOME_IDLE_START");
    let home_idle = idle(&bridge, secs, shown, home_view);
    let home_flip = flip(&bridge, "home", &signals, "BLOCKED", home_view);

    // Agent A's session, open: its workspace roster.
    let request = home.request + 1;
    let label = home
        .home_agents
        .as_ref()
        .and_then(|r| r.rows.iter().find(|row| row.name == "Fixture agent A"))
        .map(|row| row.session_label.clone())
        .unwrap();
    let id = home
        .sessions
        .iter()
        .find(|v| v.label == label)
        .unwrap()
        .id
        .clone();
    bridge
        .commands
        .send(Command::Session { request, id })
        .unwrap();
    let open = until(&bridge, "session agents", |s| {
        s.request == request && s.input_ready && session_view(s).is_some_and(|v| !v.1.is_empty())
    });
    std::thread::sleep(Duration::from_secs(5));
    let mut shown = session_view(&open);
    while let Some(s) = take(&bridge) {
        shown = session_view(&s);
    }
    let session_rows = shown.clone().unwrap().1;
    let session_idle = idle(&bridge, secs, shown, session_view);
    let session_flip = flip(&bridge, "session", &signals, "WORKING", session_view);
    eprintln!(
        "AGENT_IDLE {}",
        serde_json::json!({
            "idleSecs": secs,
            "home": {"rows": home_rows, "idle": home_idle, "flip": home_flip},
            "session": {"rows": session_rows, "idle": session_idle, "flip": session_flip},
        })
    );
    owner.shutdown().unwrap();
}
