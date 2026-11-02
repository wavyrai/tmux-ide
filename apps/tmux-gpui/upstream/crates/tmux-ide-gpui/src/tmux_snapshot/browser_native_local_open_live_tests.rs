#![allow(clippy::unwrap_used)]
//! Opening a session reaches its first frame, whatever its pane count (#706).
use super::*;
const FIRST_FRAME: Duration = Duration::from_secs(5);
fn next(
    bridge: &Bridge,
    limit: Duration,
    done: impl Fn(&State) -> bool,
) -> (Option<State>, Vec<String>) {
    let started = Instant::now();
    let mut trail: Vec<String> = Vec::new();
    while started.elapsed() < limit {
        if let Some(state) = bridge.mailbox.lock().unwrap().take() {
            let state = state.unwrap_or_else(|| panic!("native browser closed"));
            if trail
                .last()
                .is_none_or(|last| !last.ends_with(&state.status))
            {
                trail.push(format!(
                    "{}ms {}",
                    started.elapsed().as_millis(),
                    state.status
                ));
            }
            if done(&state) {
                return (Some(state), trail);
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    (None, trail)
}
/// TMUX_IDE_TEST_OPEN_SESSIONS lists session labels to open in order, going
/// Home between them; TMUX_IDE_TEST_OPEN_ACTIVE=0 opens with the window inactive,
/// TMUX_IDE_TEST_OPEN_BLUR_MS blurs the window while the session connects.
#[test]
#[ignore = "requires an owned scratch daemon with the listed sessions"]
fn every_listed_session_reaches_its_first_frame() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let labels = std::env::var("TMUX_IDE_TEST_OPEN_SESSIONS").unwrap();
    let active = std::env::var("TMUX_IDE_TEST_OPEN_ACTIVE").map_or(true, |v| v != "0");
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let mut revision = 1;
    bridge
        .commands
        .send(Command::Presence { active, revision })
        .unwrap();
    let (home, trail) = next(&bridge, Duration::from_secs(15), |s| {
        s.home_phase == HomePhase::Live && s.session_catalog_complete && !s.sessions.is_empty()
    });
    let mut home = home.unwrap_or_else(|| panic!("home never loaded: {trail:?}"));
    let mut results = Vec::new();
    for label in labels.split(',') {
        let id = home
            .sessions
            .iter()
            .find(|c| c.label == label)
            .unwrap_or_else(|| panic!("no session {label}"))
            .id
            .clone();
        let request = home.request + 1;
        let started = Instant::now();
        bridge
            .commands
            .send(Command::Session { request, id })
            .unwrap();
        // TMUX_IDE_TEST_OPEN_BLUR_MS: lose focus that long after opening, regain it 500 ms later.
        if let Some(blur) = std::env::var("TMUX_IDE_TEST_OPEN_BLUR_MS")
            .ok()
            .and_then(|v| v.parse().ok())
        {
            std::thread::sleep(Duration::from_millis(blur));
            revision += 1;
            bridge
                .commands
                .send(Command::Presence {
                    active: false,
                    revision,
                })
                .unwrap();
            std::thread::sleep(Duration::from_millis(500));
            revision += 1;
            bridge
                .commands
                .send(Command::Presence {
                    active: true,
                    revision,
                })
                .unwrap();
        }
        let (opened, trail) = next(&bridge, FIRST_FRAME, |s| {
            s.request == request && s.frame.is_some()
        });
        let took = started.elapsed().as_millis();
        eprintln!(
            "OPEN_LIVE {label} active={active} frame={} {took}ms {trail:?}",
            opened.is_some()
        );
        results.push((label.to_owned(), opened.is_some(), trail));
        revision += 1;
        bridge
            .commands
            .send(Command::Presence { active, revision })
            .unwrap();
        bridge
            .commands
            .send(Command::Home {
                request: request + 1,
            })
            .unwrap();
        let (back, trail) = next(&bridge, Duration::from_secs(15), |s| {
            s.request == request + 1
                && s.home_phase == HomePhase::Live
                && s.session_catalog_complete
                && !s.sessions.is_empty()
        });
        home = back.unwrap_or_else(|| panic!("home never came back: {trail:?}"));
    }
    owner.shutdown().unwrap();
    let hung: Vec<_> = results.iter().filter(|(_, ok, _)| !ok).collect();
    assert!(
        hung.is_empty(),
        "no first frame within {FIRST_FRAME:?}: {hung:?}"
    );
}
