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
    assert_eq!(
        Stop::new(&identity, 4, Some("2.9.7")).unwrap().status,
        "Couldn't reconnect. Refresh sessions to try again."
    );
    let disconnected = NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(
        tmux_native_session::Error::Transport(tmux_stream::Error::Disconnected),
    )));
    assert!(Stop::new(&disconnected, 4, Some("2.9.7")).is_none());
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

#[test]
fn the_daemon_version_is_trimmed_bounded_and_limited_to_version_characters() {
    let named = |v: &str| daemon_too_old(Some(v)).contains(&format!("({v})"));
    assert_eq!(
        daemon_too_old(Some("  2.9.7 ")),
        daemon_too_old(Some("2.9.7"))
    );
    assert!(named("2.9.7"));
    assert!(named("2.9.0-beta.50+build.7"));
    assert!(named(&"9".repeat(32)));
    assert_eq!(daemon_too_old(Some(&"9".repeat(33))), daemon_too_old(None));
    assert_eq!(daemon_too_old(Some("")), daemon_too_old(None));
    assert_eq!(daemon_too_old(Some("   ")), daemon_too_old(None));
    for bad in [
        "2.9.7 beta",
        "2.9.7)",
        "2.9_7",
        "v2/9",
        "2.9.7\u{0}",
        "2.9.é",
    ] {
        assert_eq!(daemon_too_old(Some(bad)), daemon_too_old(None), "{bad:?}");
    }
}

#[test]
fn the_log_line_names_the_rejecting_check_the_pane_and_the_fault() {
    use herdr_client::{tmux_receiver, tmux_terminal};
    let stopped = |error| NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(error)));
    let rejected = stopped(tmux_native_session::Error::Terminal(
        tmux_terminal::Error::Delivery(tmux_receiver::Error::Ordering),
        tmux_terminal::Failure {
            pane: Some("pane.3".into()),
            fault: None,
        },
    ));
    assert_eq!(code(&rejected), "terminal-state");
    assert_eq!(
        detail(&rejected),
        "terminal-state:delivery-ordering pane=pane.3"
    );
    let fault = stopped(tmux_native_session::Error::Terminal(
        tmux_terminal::Error::SourceClosed,
        tmux_terminal::Failure {
            pane: None,
            fault: Some("source-closed"),
        },
    ));
    assert_eq!(
        detail(&fault),
        "terminal-state:source-closed fault=source-closed"
    );
    // A pane id that is not a plain token never reaches the log.
    let odd = stopped(tmux_native_session::Error::Terminal(
        tmux_terminal::Error::Identity,
        tmux_terminal::Failure {
            pane: Some("pane\n\u{1b}[31m".into()),
            fault: None,
        },
    ));
    assert_eq!(detail(&odd), "terminal-state:identity");
    // Review round 1: the 128-character bound on a logged pane id.
    let long = stopped(tmux_native_session::Error::Terminal(
        tmux_terminal::Error::Identity,
        tmux_terminal::Failure {
            pane: Some("p".repeat(129)),
            fault: None,
        },
    ));
    assert_eq!(detail(&long), "terminal-state:identity");
    let bound = stopped(tmux_native_session::Error::Terminal(
        tmux_terminal::Error::Identity,
        tmux_terminal::Failure {
            pane: Some("p".repeat(128)),
            fault: None,
        },
    ));
    assert_eq!(
        detail(&bound),
        format!("terminal-state:identity pane={}", "p".repeat(128))
    );
}

#[test]
fn the_log_line_keeps_the_peer_close_code_and_reason() {
    let closed = |reason| {
        NativeError::Controller(tmux_controller::Error::Stopped(Arc::new(
            tmux_native_session::Error::Transport(tmux_stream::Error::Closed(tmux_stream::Close {
                code: 1013,
                reason,
            })),
        )))
    };
    let backpressure = closed(Some("output-backpressure".into()));
    assert_eq!(code(&backpressure), "stream-disconnected");
    assert!(Stop::new(&backpressure, 4, Some("2.9.12")).is_none());
    assert_eq!(
        detail(&backpressure),
        "stream-disconnected code=1013 reason=output-backpressure"
    );
    assert_eq!(detail(&closed(None)), "stream-disconnected code=1013");
}
