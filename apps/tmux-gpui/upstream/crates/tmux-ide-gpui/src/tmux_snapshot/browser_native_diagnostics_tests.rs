#![allow(clippy::unwrap_used)]
use super::*;
use std::sync::Arc;

#[test]
fn stopped_session_preserves_failure_category_without_source_payload() {
    let error = NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(
        tmux_native_session::Error::Transport(tmux_stream::Error::Io(std::io::Error::other(
            "private terminal output and capability ticket",
        ))),
    )));
    assert_eq!(code(&error), "stream-io");
    let overload = NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(
        tmux_native_session::Error::GraphicsBacklog,
    )));
    assert_eq!(code(&overload), "graphics-backlog");
}

#[test]
fn a_daemon_without_input_lifetime_stops_with_an_update_message() {
    let error = NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(
        tmux_native_session::Error::Transport(tmux_stream::Error::DaemonTooOld),
    )));
    assert_eq!(code(&error), "stream-daemon-too-old");
    assert_eq!(
        Stop::new(&error, 4, Some("2.9.7")).unwrap().status,
        "This tmux-ide daemon (2.9.7) is too old for the Mac app. Update tmux-ide to 2.9.11 or later: tmux-ide update"
    );
    assert_eq!(
        Stop::new(&error, 4, None).unwrap().status,
        "This tmux-ide daemon is too old for the Mac app. Update tmux-ide to 2.9.11 or later: tmux-ide update"
    );
    assert_eq!(
        daemon_too_old(Some("2.9.7\n\u{1b}[31m")),
        daemon_too_old(None)
    );
    let identity = NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(
        tmux_native_session::Error::Transport(tmux_stream::Error::Identity),
    )));
    assert!(Stop::new(&identity, 4, Some("2.9.7")).is_none());
}

#[test]
fn the_stop_status_survives_catalog_republication_until_a_newer_request() {
    let error = NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(
        tmux_native_session::Error::Transport(tmux_stream::Error::DaemonTooOld),
    )));
    let mut stop = Stop::new(&error, 4, Some("2.9.7"));
    let mut state = super::super::State {
        request: 4,
        status: "Connecting terminal".into(),
        ..Default::default()
    };
    Stop::apply(&mut stop, &mut state);
    assert_eq!(state.status, daemon_too_old(Some("2.9.7")));
    let mut newer = super::super::State {
        request: 5,
        status: "Opening terminal".into(),
        ..Default::default()
    };
    Stop::apply(&mut stop, &mut newer);
    assert_eq!(newer.status, "Opening terminal");
    assert!(stop.is_none());
}
