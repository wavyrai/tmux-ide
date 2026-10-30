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
        stop_message(&error),
        Some("This tmux-ide daemon is too old for the app. Update tmux-ide to 2.9.15 or later and restart it.")
    );
    let identity = NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(
        tmux_native_session::Error::Transport(tmux_stream::Error::Identity),
    )));
    assert_eq!(stop_message(&identity), None);
}
