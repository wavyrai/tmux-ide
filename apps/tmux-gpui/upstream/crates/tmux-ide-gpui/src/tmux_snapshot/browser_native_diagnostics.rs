//! Bounded diagnostic categories only: never format reflected wire errors or credentials.
use super::NativeError;
use herdr_client::{tmux_controller, tmux_native_session, tmux_stream};

pub(super) fn code(error: &NativeError) -> &'static str {
    match error {
        #[cfg(target_os = "macos")]
        NativeError::Surface(_) => "surface",
        NativeError::Handoff(_) => "handoff",
        NativeError::Input(_) => "input",
        NativeError::Action(_) => "action",
        NativeError::Owner(_) => "owner",
        NativeError::Presentation(_) => "presentation",
        NativeError::Controller(error) => match error {
            tmux_controller::Error::Retired => "controller-retired",
            tmux_controller::Error::Invalid => "controller-invalid",
            tmux_controller::Error::Control(_) => "controller-control",
            tmux_controller::Error::Session(error) => session(error),
            tmux_controller::Error::Stopped(error) => session(error),
            tmux_controller::Error::Topology(_) => "controller-topology",
            tmux_controller::Error::Json(_) => "controller-json",
            tmux_controller::Error::Transport(error) => transport(error),
        },
    }
}
fn session(error: &tmux_native_session::Error) -> &'static str {
    use tmux_native_session::Error;
    match error {
        Error::Transport(error) => transport(error),
        Error::Terminal(_) => "terminal-state",
        Error::Ack(_) => "terminal-ack",
        Error::ControlBacklog => "control-backlog",
        Error::Graphics(_) => "graphics-state",
        Error::GraphicsBacklog => "graphics-backlog",
        Error::GraphicsDisabled => "graphics-disabled",
        Error::NativeSurface(_) => "native-surface",
        Error::Cancelled => "session-cancelled",
        Error::WorkerStopped => "worker-stopped",
        Error::Mailbox => "mailbox",
        Error::Spawn(_) => "worker-spawn",
    }
}
fn transport(error: &tmux_stream::Error) -> &'static str {
    use tmux_stream::Error;
    match error {
        Error::RemoteIdentity(_) => "stream-remote-identity",
        Error::Descriptor => "stream-descriptor",
        Error::Headers => "stream-headers",
        Error::Expired => "stream-expired",
        Error::Io(_) => "stream-io",
        Error::WebSocket(_) => "stream-websocket",
        Error::Json(_) => "stream-json",
        Error::Identity => "stream-identity",
        Error::Frame => "stream-frame",
        Error::FrameBound => "stream-frame-bound",
        Error::EventBacklog => "stream-event-backlog",
        Error::CommandBacklog => "stream-command-backlog",
        Error::Disconnected => "stream-disconnected",
        Error::Cancelled => "stream-cancelled",
        Error::ReadyTimeout => "stream-ready-timeout",
    }
}

#[cfg(test)]
#[path = "browser_native_diagnostics_tests.rs"]
mod tests;
