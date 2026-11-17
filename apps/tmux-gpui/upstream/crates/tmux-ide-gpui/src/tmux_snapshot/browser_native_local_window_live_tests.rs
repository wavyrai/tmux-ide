#![allow(clippy::unwrap_used)]
//! Live (#806): a session of 30 panes over two windows (20 and 10) opens one
//! window, switches to the other and back, follows a split in the shown
//! window, and drops keys typed into the old window during a switch. Run by
//! bridge/manual/native-window-streams-smoke.mjs against a scratch daemon of
//! a release that streams one window. The harness splits after
//! `WINDOW_SPLIT_READY <window name>` and writes `split-done`.
use super::*;
use crate::tmux_snapshot::keys::Input;

fn take(bridge: &Bridge) -> Option<State> {
    let taken = bridge.mailbox.lock().unwrap().take();
    taken.map(|state| state.unwrap_or_else(|| panic!("native browser closed")))
}
/// The first state `done` accepts, and the milliseconds it took.
fn until(
    bridge: &Bridge,
    label: &str,
    limit: Duration,
    done: impl Fn(&State) -> bool,
) -> (State, u128) {
    let started = Instant::now();
    let mut last: Option<State> = None;
    loop {
        assert!(started.elapsed() < limit, "timed out at {label}");
        match take(bridge) {
            Some(s) if done(&s) => return (s, started.elapsed().as_millis()),
            Some(s) => last = Some(s),
            None if last.as_ref().is_some_and(&done) => {
                return (last.take().unwrap(), started.elapsed().as_millis());
            }
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
fn send_line(bridge: &Bridge, state: &State, pane: &str, token: &str, text: &str) {
    for input in [Input::Text(text.into()), Input::Key("Enter".into())] {
        bridge
            .commands
            .send(Command::Input {
                request: state.request,
                id: pane.into(),
                input_target: Some(token.into()),
                input,
            })
            .unwrap();
    }
}
/// Types into the selected pane and waits for the echo in the frame.
fn type_line(bridge: &Bridge, state: &State, marker: &str) -> bool {
    let pane = state.selected_pane.clone().unwrap();
    let Some(target) = state.input_targets.iter().find(|t| t.id == pane) else {
        return false;
    };
    send_line(
        bridge,
        state,
        &pane,
        &target.token,
        &format!("printf 'typed-%s\\n' {marker}"),
    );
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if take(bridge).is_some_and(|s| contains(&s, &format!("typed-{marker}"))) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}
fn window_of(state: &State, pane: &str) -> Option<String> {
    let choice = state.panes.iter().find(|choice| choice.id == pane)?;
    choice.window_id.clone()
}
fn shown(state: &State) -> (String, String, usize) {
    let pane = state.selected_pane.clone().unwrap();
    let window = window_of(state, &pane).unwrap();
    let label = (state.panes.iter())
        .find(|choice| choice.id == pane)
        .and_then(|choice| choice.window_label.clone())
        .unwrap_or_default();
    let count = (state.panes.iter())
        .filter(|choice| choice.window_id.as_deref() == Some(window.as_str()))
        .count();
    (window, label, count)
}
/// Ready on a labelled state of `request`: every window's panes listed.
fn labelled(s: &State, request: u64, panes: usize) -> bool {
    s.request == request
        && s.frame.is_some()
        && s.input_ready
        && s.window_stream
        && s.panes.len() == panes
        && s.panes.iter().all(|choice| choice.window_id.is_some())
}
/// Switches to a pane of another window: keys sent to the old window right
/// after the click must never land; the new window takes input.
fn switch(bridge: &Bridge, from: &State, n: u32) -> (State, serde_json::Value) {
    let (window, _, _) = shown(from);
    let target = (from.panes.iter())
        .find(|choice| choice.window_id.as_deref() != Some(window.as_str()))
        .unwrap()
        .id
        .clone();
    let old = from.selected_pane.clone().unwrap();
    let old_token = (from.input_targets.iter())
        .find(|t| t.id == old)
        .unwrap()
        .token
        .clone();
    let request = from.request + 1;
    bridge
        .commands
        .send(Command::Pane {
            request,
            id: target.clone(),
        })
        .unwrap();
    // Typed into the old window during the switch, as a fast typist would.
    let stray = format!("during-switch-{n}");
    send_line(
        bridge,
        from,
        &old,
        &old_token,
        &format!("printf 'typed-%s\\n' {stray}"),
    );
    let total = from.panes.len();
    let (after, ms) = until(bridge, "switch", Duration::from_secs(30), |s| {
        labelled(s, request, total) && s.selected_pane.as_deref() == Some(target.as_str())
    });
    let (new_window, _, count) = shown(&after);
    let typed = type_line(bridge, &after, &format!("after-switch-{n}"));
    let report = serde_json::json!({
        "ms": ms, "from": window, "to": new_window, "windowPanes": count,
        "typed": typed, "stray": stray,
    });
    (after, report)
}

#[test]
#[ignore = "requires a scratch daemon with window streams and its harness"]
fn a_session_over_the_pane_limit_opens_and_switches_by_window() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let signals = PathBuf::from(std::env::var_os("TMUX_IDE_TEST_SIGNAL_DIR").unwrap());
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let (home, _) = until(&bridge, "Home", Duration::from_secs(30), |s| {
        s.home_phase == HomePhase::Live && s.session_catalog_complete && !s.sessions.is_empty()
    });
    let row = home.sessions[0].clone();
    let label = row.pane_count_label().unwrap_or_default();
    let request = home.request + 1;
    bridge
        .commands
        .send(Command::Session {
            request,
            id: row.id.clone(),
        })
        .unwrap();
    let (opened, open_ms) = until(&bridge, "open", Duration::from_secs(60), |s| {
        labelled(s, request, 30)
    });
    let (first, first_label, first_count) = shown(&opened);
    let typed_open = type_line(&bridge, &opened, "after-open");
    let (there, to_other) = switch(&bridge, &opened, 1);
    let (back, to_first) = switch(&bridge, &there, 2);
    let (_, shown_label, before) = shown(&back);
    eprintln!("WINDOW_SPLIT_READY {shown_label}");
    let split_signal = signals.join("split-done");
    let (split, split_ms) = until(&bridge, "split", Duration::from_secs(60), |s| {
        split_signal.exists() && labelled(s, back.request, 31) && shown(s).2 == before + 1
    });
    let typed_split = type_line(&bridge, &split, "after-split");
    eprintln!(
        "WINDOW_LIVE {}",
        serde_json::json!({
            "homeLabel": label, "largestWindow": row.largest_window,
            "open": {"ms": open_ms, "window": first, "label": first_label, "windowPanes": first_count,
                     "typed": typed_open},
            "switchToOther": to_other, "switchBack": to_first,
            "split": {"ms": split_ms, "windowPanesBefore": before, "request": split.request,
                      "sameRequest": split.request == back.request, "typed": typed_split},
        })
    );
    owner.shutdown().unwrap();
    assert!(!label.contains("too many"), "{label}");
    assert_eq!(first_count, 20, "opens the active window");
    assert!(typed_open && to_other["typed"] == true && to_first["typed"] == true);
    assert_eq!(to_other["windowPanes"], 10);
    assert_eq!(to_first["to"], serde_json::json!(first));
    assert!(
        split.request == back.request,
        "a split re-issued the stream"
    );
    assert!(typed_split, "typing did not land after the split");
}
