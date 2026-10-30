#![allow(clippy::unwrap_used)]
//! A daemon older than 2.9.11 lacks interactive input lifetime (capability 105).
use super::*;
#[test]
#[ignore = "requires an isolated scratch daemon older than tmux-ide 2.9.11"]
fn old_daemon_shows_the_update_status_without_reconnecting() {
    let record = std::env::var_os("TMUX_IDE_TEST_OLD_DAEMON_RECORD").unwrap();
    let version = std::env::var("TMUX_IDE_TEST_OLD_DAEMON_VERSION").unwrap();
    let expected = format!(
        "This tmux-ide daemon ({version}) is too old for the Mac app. Update tmux-ide to 2.9.11 or later: tmux-ide update"
    );
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut latest: Option<State> = None;
    let mut opened = None;
    let mut stopped_at = None;
    while Instant::now() < deadline {
        if let Some(state) = bridge.mailbox.lock().unwrap().take() {
            let state = state.unwrap_or_else(|| panic!("native browser closed"));
            if opened.is_none()
                && state.home_phase == HomePhase::Live
                && state.session_catalog_complete
                && !state.sessions.is_empty()
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
            if let Some(request) = opened {
                assert!(state.request <= request);
                if state.request == request {
                    assert!(!state.input_ready);
                    // Any reconnect replaces the status with "Connection lost…".
                    if stopped_at.is_some() {
                        assert_eq!(state.status, expected);
                    } else if state.status == expected {
                        stopped_at = Some(Instant::now());
                    }
                }
            }
            latest = Some(state);
        }
        if stopped_at.is_some_and(|at| at.elapsed() > Duration::from_secs(10)) {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let latest = latest.unwrap();
    assert!(stopped_at.is_some(), "status was {:?}", latest.status);
    assert_eq!(latest.status, expected);
    owner.shutdown().unwrap();
}
