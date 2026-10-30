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
/// Capability 105 (input lifetime) first shipped in tmux-ide 2.9.11.
pub(super) fn daemon_too_old(version: Option<&str>) -> String {
    let version = version.map(str::trim).filter(|v| {
        !v.is_empty()
            && v.len() <= 32
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b))
    });
    match version {
        Some(version) => format!(
            "This tmux-ide daemon ({version}) is too old for the Mac app. Update tmux-ide to 2.9.11 or later: tmux-ide update"
        ),
        None => "This tmux-ide daemon is too old for the Mac app. Update tmux-ide to 2.9.11 or later: tmux-ide update".into(),
    }
}

/// A terminal failure that no reconnect can fix, kept on screen for its request.
pub(super) struct Stop {
    request: u64,
    pub(super) status: String,
}
impl Stop {
    pub(super) fn new(error: &NativeError, request: u64, version: Option<&str>) -> Option<Self> {
        let status = match code(error) {
            "stream-daemon-too-old" => daemon_too_old(version),
            // A peer that fails identity is not the daemon we issued against.
            "stream-identity" | "stream-remote-identity" => {
                "Couldn't reconnect. Refresh sessions to try again.".into()
            }
            _ => return None,
        };
        Some(Self { request, status })
    }
    /// The catalog owner republishes its own status; keep the stop until a newer request.
    pub(super) fn apply(stop: &mut Option<Self>, state: &mut super::State) {
        match stop {
            Some(current) if state.request > current.request => *stop = None,
            Some(current) if state.request == current.request && state.frame.is_none() => {
                state.status.clone_from(&current.status);
            }
            _ => {}
        }
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
        Error::DaemonTooOld => "stream-daemon-too-old",
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
