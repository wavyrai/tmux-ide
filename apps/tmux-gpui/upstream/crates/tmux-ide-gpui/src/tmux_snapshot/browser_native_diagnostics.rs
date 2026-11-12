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
            tmux_controller::Error::Topology(herdr_client::tmux_topology::Error::Unissued) => {
                "controller-topology-panes-changed"
            }
            tmux_controller::Error::Topology(_) => "controller-topology",
            tmux_controller::Error::Json(_) => "controller-json",
            tmux_controller::Error::Transport(error) => transport(error),
        },
    }
}
/// The code plus bounded context for the log: which check rejected a pane's
/// update, the pane, and the daemon's fault reason; or the peer's close code and
/// reason. Only tokens the wire already validated, never terminal content.
pub(super) fn detail(error: &NativeError) -> String {
    let mut text = code(error).to_owned();
    let session = session_error(error);
    let close = close(error);
    if let Some(tmux_native_session::Error::Terminal(source, failure)) = session {
        text.push(':');
        text.push_str(source.code());
        if let Some(pane) = failure.pane.as_deref().filter(|pane| token(pane)) {
            text.push_str(" pane=");
            text.push_str(pane);
        }
        if let Some(fault) = failure.fault {
            text.push_str(" fault=");
            text.push_str(fault);
        }
    }
    if let Some(close) = close {
        text.push_str(&format!(" code={}", close.code));
        if let Some(reason) = close.reason.as_deref().filter(|reason| token(reason)) {
            text.push_str(" reason=");
            text.push_str(reason);
        }
    }
    text
}
fn session_error(error: &NativeError) -> Option<&tmux_native_session::Error> {
    match error {
        NativeError::Controller(tmux_controller::Error::Session(error)) => Some(error),
        NativeError::Controller(tmux_controller::Error::Stopped(error)) => Some(error.as_ref()),
        _ => None,
    }
}
/// The peer's close frame, when the stream ended with one.
fn close(error: &NativeError) -> Option<&tmux_stream::Close> {
    match (error, session_error(error)) {
        (
            NativeError::Controller(tmux_controller::Error::Transport(tmux_stream::Error::Closed(
                close,
            ))),
            _,
        )
        | (_, Some(tmux_native_session::Error::Transport(tmux_stream::Error::Closed(close)))) => {
            Some(close)
        }
        _ => None,
    }
}
/// Why the stream ended, for the catalog's reconnect policy. The reason
/// decides, not the code. A reason this app does not know is a plain close:
/// reconnect. So is 1001 "daemon-shutdown", which a 2.9.22 daemon sends for
/// every close while it stays up.
pub(super) fn cause(error: &NativeError) -> super::Cause {
    use super::Cause;
    if let Some(close) = close(error) {
        return match close.reason.as_deref() {
            Some("tmux-server-retired") => Cause::ServerRetired,
            Some("daemon-restarting") => Cause::DaemonRestarting,
            Some("panes-closed") => Cause::PanesClosed,
            _ => Cause::Closed,
        };
    }
    match code(error) {
        "stream-identity" => Cause::Identity,
        "stream-silent" => Cause::Silent,
        _ => Cause::Lost,
    }
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"%$@._:-".contains(&b))
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
            // Over SSH a peer that fails identity may be another machine. A
            // local "stream-identity" (a ready frame that is not the lease's,
            // as after the daemon rebuilt the server owner) is recovered like
            // any drop: the catalog proves the daemon again before a new lease.
            "stream-remote-identity" => "Couldn't reconnect. Refresh sessions to try again.".into(),
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
        Error::Terminal(..) => "terminal-state",
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
        // A close with a reason is still a disconnect for policy; `detail` adds the reason.
        Error::Disconnected | Error::Closed(_) => "stream-disconnected",
        Error::Cancelled => "stream-cancelled",
        Error::ReadyTimeout => "stream-ready-timeout",
    }
}

#[cfg(test)]
#[path = "browser_native_diagnostics_tests.rs"]
mod tests;
