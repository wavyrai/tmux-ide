#![allow(clippy::unwrap_used)]
//! Live: Home keeps its session list and reconnects by itself while a harness
//! disturbs a scratch daemon (`apps/tmux-gpui/scripts/home-reconnect-live.mjs`).
//! The harness writes `disturbed` when it starts, then `restored` once the
//! daemon is back, or nothing more when Home should stop with a reason.
use super::*;

fn signalled(dir: &std::path::Path, name: &str) -> bool {
    dir.join(name).exists()
}

#[test]
#[ignore = "requires apps/tmux-gpui/scripts/home-reconnect-live.mjs and a scratch daemon"]
fn home_keeps_its_list_and_reconnects_after_a_daemon_disturbance() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let signals = PathBuf::from(std::env::var_os("TMUX_IDE_TEST_SIGNAL_DIR").unwrap());
    let expect_fault = std::env::var("TMUX_IDE_TEST_EXPECT").is_ok_and(|v| v == "fault");
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let take = || {
        bridge
            .mailbox
            .lock()
            .unwrap()
            .take()
            .map(|state| state.unwrap_or_else(|| panic!("native browser closed")))
    };
    let started = Instant::now();
    let initial = loop {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "Home never loaded"
        );
        if let Some(s) = take()
            && s.home_phase == HomePhase::Live
            && s.session_catalog_complete
            && !s.sessions.is_empty()
        {
            break s.sessions.len();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    eprintln!("HOME_READY");
    let mut reconnecting_seen = false;
    let mut restored_at: Option<Instant> = None;
    let deadline = Instant::now() + Duration::from_secs(150);
    loop {
        assert!(Instant::now() < deadline, "the harness never finished");
        if restored_at.is_none() && signalled(&signals, "restored") {
            restored_at = Some(Instant::now());
        }
        if let Some(s) = take() {
            if signalled(&signals, "disturbed") {
                assert_ne!(s.home_phase, HomePhase::Unavailable, "status: {}", s.status);
                assert!(
                    s.sessions.len() >= initial,
                    "the last good list stays on screen"
                );
                reconnecting_seen |= s.reconnect_attempt.is_some();
            }
            if expect_fault && s.home_fault {
                assert!(s.status.contains("needs an update"), "status: {}", s.status);
                eprintln!("HOME_FAULT {}", s.status);
                break;
            }
            if let Some(at) = restored_at.filter(|_| !expect_fault)
                && reconnecting_seen
                && !s.home_fault
                && s.reconnect_attempt.is_none()
                && s.status == "Sessions ready"
            {
                eprintln!(
                    "HOME_RECOVERED {} ms after restore, {} sessions",
                    at.elapsed().as_millis(),
                    s.sessions.len()
                );
                break;
            }
        }
        if let Some(at) = restored_at {
            assert!(
                at.elapsed() < Duration::from_secs(45),
                "Home did not reconnect within 45 s of the restore (reconnecting seen: {reconnecting_seen})"
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    owner.shutdown().unwrap();
}
