#![allow(clippy::unwrap_used)]
//! A harness restarts the scratch daemon's terminal source once this test prints
//! `FAULT_LOG_READY`. Both logs must then name the same fault.
use super::*;
#[test]
#[ignore = "requires a scratch daemon whose pane source the harness restarts"]
fn a_source_restart_is_named_in_the_app_log() {
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let next = || {
        bridge
            .mailbox
            .lock()
            .unwrap()
            .take()
            .map(|state| state.unwrap_or_else(|| panic!("native browser closed")))
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut opened = None;
    let live = loop {
        assert!(Instant::now() < deadline, "session never connected");
        let Some(state) = next() else {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        };
        match opened {
            None if state.home_phase == HomePhase::Live
                && state.session_catalog_complete
                && !state.sessions.is_empty() =>
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
            Some(request)
                if state.request == request && state.frame.is_some() && state.input_ready =>
            {
                break state;
            }
            _ => {}
        }
    };
    eprintln!("FAULT_LOG_READY");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut trail = Vec::new();
    let interrupted = loop {
        assert!(Instant::now() < deadline, "no interruption: {trail:?}");
        let Some(state) = next() else {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        };
        if trail.last() != Some(&state.status) {
            trail.push(state.status.clone());
        }
        if !state.input_ready {
            break state;
        }
    };
    assert!(interrupted.request >= live.request, "{trail:?}");
    eprintln!("FAULT_LOG_LIVE {trail:?}");
    owner.shutdown().unwrap();
}
