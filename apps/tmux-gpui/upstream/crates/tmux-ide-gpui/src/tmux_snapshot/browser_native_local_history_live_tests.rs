#![allow(clippy::unwrap_used)]
//! Live (capability 122): a pane with ~2000 rows of history opens with the
//! newest 200 loaded; scrolling up loads older rows by request, until the
//! scrollback holds all it can (`tmux_history::MAX_ROWS` and `MAX_BYTES`,
//! about 250 rows of an 80-column pane). Run by
//! bridge/manual/native-history-on-demand-smoke.mjs against a scratch daemon
//! of a release with history on demand.
use super::*;
use crate::tmux_snapshot::keys::Input;

fn take(bridge: &Bridge) -> Option<State> {
    let taken = bridge.mailbox.lock().unwrap().take();
    taken.map(|state| state.unwrap_or_else(|| panic!("native browser closed")))
}
fn until(
    bridge: &Bridge,
    label: &str,
    limit: Duration,
    mut done: impl FnMut(&State) -> bool,
) -> (State, u128) {
    let started = Instant::now();
    let mut last: Option<State> = None;
    loop {
        assert!(started.elapsed() < limit, "timed out at {label}");
        match take(bridge) {
            Some(s) if done(&s) => return (s, started.elapsed().as_millis()),
            Some(s) => last = Some(s),
            None if last.as_ref().is_some_and(&mut done) => {
                return (last.take().unwrap(), started.elapsed().as_millis());
            }
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    }
}
fn scroll(bridge: &Bridge, state: &State, lines: i16) {
    let pane = state.selected_pane.clone().unwrap();
    let target = (state.input_targets.iter())
        .find(|t| t.id == pane)
        .map(|t| t.token.clone());
    bridge
        .commands
        .send(Command::Input {
            request: state.request,
            id: pane,
            input_target: target,
            input: Input::Scroll(lines),
        })
        .unwrap();
}
/// The smallest line number `seq` printed that the frame shows.
fn oldest_number(state: &State) -> Option<u64> {
    let frame = state.frame.as_ref()?;
    let view = frame.view();
    (0..usize::from(view.height()))
        .filter_map(|y| {
            let text: String = view.row(y)?.iter().map(|c| c.symbol.as_str()).collect();
            text.trim().parse::<u64>().ok()
        })
        .min()
}

#[test]
#[ignore = "requires a scratch daemon with history on demand and its harness"]
fn scrolling_up_loads_older_history_by_request() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let (home, _) = until(&bridge, "Home", Duration::from_secs(30), |s| {
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
    let (opened, open_ms) = until(&bridge, "open", Duration::from_secs(60), |s| {
        s.request == request && s.frame.is_some() && s.input_ready
    });
    // Up to the oldest of the seed's 200 rows, and a little past it: the
    // scrollback stops there until older rows load.
    let mut state = opened.clone();
    scroll(&bridge, &state, 400);
    let (at_seed, _) = until(&bridge, "seed rows", Duration::from_secs(10), |s| {
        s.history_offset > 0
    });
    let seed_offset = at_seed.history_offset;
    state = at_seed;
    // Keep scrolling: the 500-row chunk lets the view go past 200.
    let started = Instant::now();
    let mut past_seed_ms = None;
    let mut stable = 0;
    let mut last = state.history_offset;
    while started.elapsed() < Duration::from_secs(30) && stable < 10 {
        scroll(&bridge, &state, 200);
        std::thread::sleep(Duration::from_millis(100));
        while let Some(next) = take(&bridge) {
            state = next;
        }
        if past_seed_ms.is_none() && state.history_offset > 200 {
            past_seed_ms = Some(started.elapsed().as_millis());
        }
        if past_seed_ms.is_some() && state.history_offset == last {
            stable += 1;
        } else {
            stable = 0;
        }
        last = state.history_offset;
    }
    let top = state;
    let oldest = oldest_number(&top);
    eprintln!(
        "HISTORY_LIVE {}",
        serde_json::json!({
            "openMs": open_ms, "seedOffset": seed_offset,
            "pastSeedMs": past_seed_ms,
            "finalOffset": top.history_offset, "oldestShown": oldest,
        })
    );
    owner.shutdown().unwrap();
    assert!(seed_offset <= 200, "the seed holds 200 rows: {seed_offset}");
    assert!(past_seed_ms.is_some(), "older rows never loaded");
    assert!(top.history_offset > 200, "{}", top.history_offset);
    // The frame shows rows older than any the seed carried.
    assert!(oldest.is_some_and(|n| n < 2800), "{oldest:?}");
}
