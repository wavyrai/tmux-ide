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
