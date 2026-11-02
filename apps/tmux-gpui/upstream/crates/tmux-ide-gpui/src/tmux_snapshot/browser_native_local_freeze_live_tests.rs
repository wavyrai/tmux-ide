#![allow(clippy::unwrap_used)]
//! Typing still lands after the daemon freezes past tmux's pause-after while
//! panes stream output (#702, #706). tmux pauses a pane for a control client
//! that falls more than 2 s behind (`attach -f pause-after=2`); the session
//! must come back live, not "Connected" with input that never appears.
use super::*;
use std::process::Command as Process;

fn frame_text(state: &State) -> String {
    state.frame.as_ref().map_or_else(String::new, |f| {
        let view = f.view();
        (0..view.height())
            .map(|y| {
                view.row(usize::from(y))
                    .unwrap_or_default()
                    .iter()
                    .map(|cell| cell.symbol.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

/// Latest state until `done` holds, with the status trail.
fn until(
    bridge: &Bridge,
    limit: Duration,
    done: impl Fn(&State) -> bool,
) -> (Option<State>, Vec<String>) {
    let started = Instant::now();
    let mut trail: Vec<String> = Vec::new();
    let mut last = None;
    while started.elapsed() < limit {
        if let Some(state) = bridge.mailbox.lock().unwrap().take() {
            let state = state.unwrap_or_else(|| panic!("native browser closed"));
            if trail.last().is_none_or(|t| !t.ends_with(&state.status)) {
                trail.push(format!(
                    "{}ms {}",
                    started.elapsed().as_millis(),
                    state.status
                ));
            }
            if done(&state) {
                return (Some(state), trail);
            }
            last = Some(state);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    (last, trail)
}

/// Setup and fault injection only; the app's own path is what is measured.
fn tmux(socket: &str, args: &[&str]) -> String {
    let out = Process::new("tmux")
        .arg("-S")
        .arg(socket)
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn signal(pid: u64, name: &str) {
    assert!(
        Process::new("kill")
            .arg(format!("-{name}"))
            .arg(pid.to_string())
            .status()
            .unwrap()
            .success()
    );
}

/// Env: TMUX_IDE_TEST_DAEMON_RECORD (owned scratch daemon), TMUX_IDE_TEST_TMUX_SOCKET
/// (that daemon's private tmux socket), TMUX_IDE_TEST_FREEZE_SESSION (default p8),
/// TMUX_IDE_TEST_FREEZE_SECS (default 5, must exceed pause-after=2).
#[test]
#[ignore = "requires an owned scratch daemon it freezes with SIGSTOP"]
fn typing_lands_after_a_daemon_freeze_with_output_flowing() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let socket = std::env::var("TMUX_IDE_TEST_TMUX_SOCKET").unwrap();
    let label = std::env::var("TMUX_IDE_TEST_FREEZE_SESSION").unwrap_or_else(|_| "p8".into());
    let secs: u64 = std::env::var("TMUX_IDE_TEST_FREEZE_SECS").map_or(5, |v| v.parse().unwrap());
    let daemon: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
    let pid = daemon["pid"].as_u64().unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    bridge
        .commands
        .send(Command::Presence {
            active: true,
            revision: 1,
        })
        .unwrap();
    let (home, trail) = until(&bridge, Duration::from_secs(15), |s| {
        s.home_phase == HomePhase::Live && s.session_catalog_complete && !s.sessions.is_empty()
    });
    let home = home.unwrap_or_else(|| panic!("home never loaded: {trail:?}"));
    let id = home
        .sessions
        .iter()
        .find(|c| c.label == label)
        .unwrap()
        .id
        .clone();
    let request = home.request + 1;
    bridge
        .commands
        .send(Command::Session { request, id })
        .unwrap();
    let (live, trail) = until(&bridge, Duration::from_secs(15), |s| {
        s.request == request && s.frame.is_some() && s.input_ready
    });
    let live = live
        .filter(|s| s.input_ready)
        .unwrap_or_else(|| panic!("never live: {trail:?}"));
    let pane = live.selected_pane.clone().unwrap();

    // Output in every pane of the session, then freeze the daemon past pause-after.
    let panes = tmux(
        &socket,
        &[
            "list-panes",
            "-s",
            "-t",
            &format!("={label}"),
            "-F",
            "#{pane_id}",
        ],
    );
    for target in panes.lines() {
        tmux(
            &socket,
            &[
                "send-keys",
                "-t",
                target,
                "while :; do seq 1 400; done",
                "Enter",
            ],
        );
    }
    std::thread::sleep(Duration::from_millis(500));
    signal(pid, "STOP");
    std::thread::sleep(Duration::from_secs(secs));
    signal(pid, "CONT");
    for target in panes.lines() {
        tmux(&socket, &["send-keys", "-t", target, "C-c", ""]);
    }

    // The app must come back live, and typed text must reach the pane.
    let (back, trail) = until(&bridge, Duration::from_secs(20), |s| {
        s.frame.is_some() && s.input_ready
    });
    let back = back
        .filter(|s| s.input_ready)
        .unwrap_or_else(|| panic!("never live again: {trail:?}"));
    std::thread::sleep(Duration::from_millis(300));
    let marker = format!("FREEZE{}", std::process::id());
    for input in [
        crate::tmux_snapshot::keys::Input::Text(format!("echo {marker}")),
        crate::tmux_snapshot::keys::Input::Key("Enter".into()),
    ] {
        bridge
            .commands
            .send(Command::Input {
                input_target: None,
                request: back.request,
                id: back.selected_pane.clone().unwrap_or_else(|| pane.clone()),
                input,
            })
            .unwrap();
    }
    let (landed, after) = until(&bridge, Duration::from_secs(10), |s| {
        frame_text(s)
            .lines()
            .any(|row| row.split_whitespace().next() == Some(marker.as_str()))
    });
    let shown = landed.as_ref().is_some_and(|s| {
        frame_text(s)
            .lines()
            .any(|row| row.split_whitespace().next() == Some(marker.as_str()))
    });
    let in_tmux = panes.lines().any(|target| {
        tmux(&socket, &["capture-pane", "-p", "-S", "-200", "-t", target]).contains(&marker)
    });
    eprintln!(
        "FREEZE_LIVE session={label} freeze={secs}s shown={shown} tmux_received={in_tmux} reconnect={trail:?} after={after:?}"
    );
    if std::env::var_os("TMUX_IDE_TEST_FREEZE_DUMP").is_some() {
        eprintln!(
            "FREEZE_FRAME\n{}",
            landed.as_ref().map(frame_text).unwrap_or_default()
        );
    }
    owner.shutdown().unwrap();
    assert!(
        in_tmux,
        "typed text never reached tmux after the freeze: {trail:?} {after:?}"
    );
    assert!(
        shown,
        "typed text reached tmux but never painted: {trail:?} {after:?}"
    );
}
