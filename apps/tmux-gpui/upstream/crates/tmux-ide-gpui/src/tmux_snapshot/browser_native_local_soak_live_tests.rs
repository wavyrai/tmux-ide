//! Connection soak, the app half. A harness (bridge/manual/native-connection-soak.mjs)
//! owns a scratch daemon and tmux server and injects faults in a loop; this
//! test is the app without a window. It opens a session, watches every
//! publication, and prints one `SOAK_EVENT` line per disconnect, recovery,
//! ended session, lost key and state that did not recover by itself. It never
//! asserts on a single fault: the harness judges the whole run.
//!
//! Live means: the session's own frame is shown, no reconnect is pending, and
//! output still arrives. An active window proves the last by typing a line
//! every two seconds and reading it back; an inactive one (`…_INACTIVE=1`)
//! cannot type, so the harness prints `beat-N` lines into the pane instead.
use super::*;
use std::time::SystemTime;

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}
fn signal(name: &str) -> Option<String> {
    let dir = std::env::var_os("TMUX_IDE_TEST_SIGNAL_DIR")?;
    std::fs::read_to_string(PathBuf::from(dir).join(name)).ok()
}
fn emit(mut event: serde_json::Value) {
    let at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    event["at"] = serde_json::json!(u64::try_from(at).unwrap_or(u64::MAX));
    eprintln!("SOAK_EVENT {event}");
}
/// Every `prefix-N` number printed on screen (an output line, not the typed command).
fn counters(state: &State, prefix: &str) -> Vec<u64> {
    let Some(frame) = state.frame.as_ref() else {
        return Vec::new();
    };
    let view = frame.view();
    (0..usize::from(view.height()))
        .filter_map(|y| view.row(y))
        .filter_map(|cells| {
            let line: String = cells.iter().map(|cell| cell.symbol.as_str()).collect();
            let rest = line.trim_start().strip_prefix(prefix)?;
            let digits = rest.split(|c: char| !c.is_ascii_digit()).next()?;
            digits.parse().ok()
        })
        .collect()
}
fn label(state: &State) -> Option<String> {
    let selected = state.selected_session.as_ref()?;
    (state.sessions.iter())
        .find(|choice| &choice.id == selected)
        .map(|choice| choice.label.clone())
}
fn describe(state: &State) -> serde_json::Value {
    serde_json::json!({
        "status": state.status,
        "surface": if state.surface == Surface::Home { "home" } else { "workspace" },
        "homePhase": format!("{:?}", state.home_phase),
        "attempt": state.reconnect_attempt,
        "inputReady": state.input_ready,
        "frame": state.frame.is_some(),
        "held": state.retained_preview,
        "notice": state.home_notice,
        "sessions": state.sessions.len(),
    })
}
/// Sends one heartbeat line through the app's own input path.
fn type_beat(bridge: &Bridge, state: &State, n: u64) -> bool {
    let Some(pane) = state.selected_pane.clone() else {
        return false;
    };
    let Some(target) = state.input_targets.iter().find(|t| t.id == pane) else {
        return false;
    };
    [
        Input::Text(format!("printf 'hb-%s\\n' {n}")),
        Input::Key("Enter".into()),
    ]
    .into_iter()
    .all(|input| {
        bridge
            .commands
            .send(Command::Input {
                request: state.request,
                id: pane.clone(),
                input_target: Some(target.token.clone()),
                input,
            })
            .is_ok()
    })
}
struct Down {
    at: Instant,
    /// When the fault was last still being injected: the limit counts from
    /// here, so a daemon frozen for 50 s is not "stuck" after 45.
    clock: Instant,
    fault: String,
    trail: Vec<String>,
    /// What it took beyond waiting: "activate" (a click on the window), "refresh".
    manual: Vec<&'static str>,
    ended: bool,
    told_keys: bool,
}
/// A typed line whose output has not been seen yet.
struct Beat {
    n: u64,
    dropped: bool,
    told: bool,
}

#[test]
#[ignore = "requires the connection soak harness and its scratch daemon"]
fn connection_soak() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let inactive = var("TMUX_IDE_SOAK_INACTIVE").as_deref() == Some("1");
    let limit = Duration::from_secs(
        var("TMUX_IDE_SOAK_RECOVER_LIMIT_S")
            .and_then(|s| s.parse().ok())
            .unwrap_or(90),
    );
    let stale = Duration::from_secs(8);
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let mut presence = 0u64;
    let mut activate = |bridge: &Bridge, active: bool| {
        presence += 1;
        let _ = bridge.commands.send(Command::Presence {
            active,
            revision: presence,
        });
    };
    let mut request = 0u64;
    let mut opened = false;
    let mut last: Option<State> = None;
    let mut ever_live = false;
    let mut down: Option<Down> = None;
    let mut fresh_at = Instant::now();
    let mut seen_counter = 0u64;
    let mut beats: Vec<Beat> = Vec::new();
    let mut next_beat = 1u64;
    let mut beat_due = Instant::now();
    let mut window_active = true;
    let started = Instant::now();
    while signal("stop").is_none() {
        let Some(state) = next(&bridge).or_else(|| {
            std::thread::sleep(Duration::from_millis(5));
            last.clone()
        }) else {
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "the app published nothing"
            );
            continue;
        };
        last = Some(state.clone());
        let home = state.surface == Surface::Home
            && state.home_phase == HomePhase::Live
            && state.session_catalog_complete
            && !state.sessions.is_empty();
        // Home with the list, and nothing of ours pending: open a session.
        // First at start; later only after the app itself returned to Home
        // (the session ended) or after this test refreshed a stuck window.
        if home && state.request >= request && state.reconnect_attempt.is_none() {
            if opened && let Some(d) = down.as_mut() {
                if !d.ended && d.manual.is_empty() {
                    emit(serde_json::json!({"event": "ended", "fault": d.fault,
                        "ms": d.at.elapsed().as_millis() as u64, "state": describe(&state)}));
                }
                d.ended = true;
            }
            if !window_active {
                // Opening a session is the user's click: it activates the window.
                activate(&bridge, true);
                window_active = true;
            }
            request = state.request + 1;
            let _ = bridge.commands.send(Command::Session {
                request,
                id: state.sessions[0].id.clone(),
            });
            opened = true;
            continue;
        }
        let attached = opened
            && state.request == request
            && state.surface == Surface::Workspace
            && state.frame.is_some()
            && !state.retained_preview
            && state.reconnect_attempt.is_none()
            && (!window_active || state.input_ready);
        // Output still arrives: the typed heartbeat or the harness's beat.
        let prefix = if inactive { "beat-" } else { "hb-" };
        let shown = counters(&state, prefix);
        if let Some(n) = shown.iter().copied().max().filter(|n| *n > seen_counter) {
            seen_counter = n;
            fresh_at = Instant::now();
        }
        for b in &mut beats {
            b.dropped |= state.reconnect_attempt.is_some() || !attached;
            b.told |= state.status.contains(hold::LOST_INPUT);
        }
        // Output is in order: a typed line is lost once a later one came back
        // without it. A slow daemon only delays lines, which is not a loss.
        // With a drop in between the app must have said so; without one the
        // key vanished silently.
        if let Some(latest) = shown.iter().copied().max() {
            beats.retain(|b| {
                if b.n >= latest || shown.contains(&b.n) {
                    return b.n > latest;
                }
                let fault = signal("fault").unwrap_or_default().trim().to_owned();
                emit(serde_json::json!({"event": "key-lost", "n": b.n,
                    "dropped": b.dropped, "told": b.told, "fault": fault}));
                false
            });
        }
        if !inactive && attached && beats.len() < 3 && Instant::now() >= beat_due {
            if type_beat(&bridge, &state, next_beat) {
                beats.push(Beat {
                    n: next_beat,
                    dropped: false,
                    told: false,
                });
                next_beat += 1;
            }
            beat_due = Instant::now() + Duration::from_secs(2);
        }
        let live = attached && fresh_at.elapsed() < stale;
        match (&mut down, live) {
            (None, true) => {
                if !ever_live {
                    ever_live = true;
                    emit(
                        serde_json::json!({"event": "ready", "session": label(&state),
                        "inactive": inactive}),
                    );
                    if inactive {
                        activate(&bridge, false);
                        window_active = false;
                    }
                }
            }
            (None, false) if ever_live => {
                let fault = signal("fault").unwrap_or_default().trim().to_owned();
                emit(serde_json::json!({"event": "down", "fault": fault,
                    "frozen": attached, "state": describe(&state)}));
                down = Some(Down {
                    at: Instant::now(),
                    clock: Instant::now(),
                    fault,
                    trail: vec![state.status.clone()],
                    manual: Vec::new(),
                    ended: false,
                    told_keys: false,
                });
            }
            (None, false) => {}
            (Some(d), true) => {
                emit(serde_json::json!({"event": "up", "fault": d.fault,
                    "ms": d.at.elapsed().as_millis() as u64,
                    "msAfterFault": d.clock.elapsed().as_millis() as u64, "manual": d.manual,
                    "ended": d.ended, "toldKeys": d.told_keys, "trail": d.trail,
                    "session": label(&state)}));
                down = None;
                if inactive && window_active {
                    activate(&bridge, false);
                    window_active = false;
                }
            }
            (Some(d), false) => {
                d.told_keys |= state.status.contains(hold::LOST_INPUT);
                if d.trail.last() != Some(&state.status) && d.trail.len() < 40 {
                    d.trail.push(state.status.clone());
                }
                if signal("busy").is_some() {
                    d.clock = Instant::now();
                }
                let waited = d.clock.elapsed();
                let step = d.manual.len();
                // It did not recover by itself. Record it, then do what a user
                // would, so the soak goes on: click the window, then refresh.
                if !window_active && step == 0 && waited > limit {
                    emit(
                        serde_json::json!({"event": "stuck", "fault": d.fault, "needs": "activate",
                        "ms": waited.as_millis() as u64, "state": describe(&state)}),
                    );
                    d.manual.push("activate");
                    activate(&bridge, true);
                    window_active = true;
                } else if (window_active && step == 0 && waited > limit)
                    || (step == 1 && d.manual[0] == "activate" && waited > limit * 2)
                    || (step >= 1 && waited > limit * (step as u32 + 2))
                {
                    emit(
                        serde_json::json!({"event": "stuck", "fault": d.fault, "needs": "refresh",
                        "ms": waited.as_millis() as u64, "state": describe(&state)}),
                    );
                    d.manual.push("refresh");
                    if !window_active {
                        activate(&bridge, true);
                        window_active = true;
                    }
                    request = state.request.max(request) + 1;
                    let _ = bridge.commands.send(Command::Refresh { request });
                    fresh_at = Instant::now();
                }
            }
        }
    }
    emit(
        serde_json::json!({"event": "stopped", "down": down.as_ref().map(|d| d.fault.clone()),
        "state": last.as_ref().map(describe)}),
    );
    owner.shutdown().unwrap();
}

/// The app starts before its daemon (a login item racing launchd, or a daemon
/// that is being restarted). Home must load by itself once the daemon is up:
/// this test sends no command at all.
#[test]
#[ignore = "requires the connection soak harness in late-daemon mode"]
fn home_loads_when_the_daemon_starts_after_the_app() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let wait = |limit: u64, what: &str, done: &dyn Fn(&State) -> bool| {
        let started = Instant::now();
        let mut last = String::new();
        loop {
            assert!(
                started.elapsed() < Duration::from_secs(limit),
                "{what}: timed out on {last:?}"
            );
            match next(&bridge) {
                Some(state) if done(&state) => return started.elapsed(),
                Some(state) => last = state.status,
                None => std::thread::sleep(Duration::from_millis(5)),
            }
        }
    };
    wait(30, "Home never reported the missing daemon", &|s| {
        s.home_phase == HomePhase::Unavailable
    });
    eprintln!("LATE_DAEMON_READY");
    let took = wait(90, "Home never loaded", &|s| {
        s.home_phase == HomePhase::Live && s.session_catalog_complete && !s.sessions.is_empty()
    });
    eprintln!("LATE_DAEMON_LOADED {}", took.as_millis());
    owner.shutdown().unwrap();
}
