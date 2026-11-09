#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::tmux_daemon::{CatalogEventError, CatalogWatchError, Error as DaemonError};

fn watch(error: CatalogWatchError) -> DaemonError {
    DaemonError::CatalogWatch(Box::new(error))
}
fn io(kind: std::io::ErrorKind) -> std::io::Error {
    std::io::Error::from(kind)
}

#[test]
fn transient_failures_are_retried() {
    use std::io::ErrorKind;
    let closed_1013 = tungstenite::Error::ConnectionClosed;
    for error in [
        DaemonError::IdentityChanged,
        DaemonError::RecordChanged,
        DaemonError::OwnerExited,
        DaemonError::RecordIo(io(ErrorKind::NotFound)),
        DaemonError::RequestStatus(500),
        DaemonError::RequestStatus(503),
        DaemonError::ServerChanged,
        watch(CatalogWatchError::Io(io(ErrorKind::ConnectionRefused))),
        watch(CatalogWatchError::Io(io(ErrorKind::ConnectionReset))),
        watch(CatalogWatchError::Timeout),
        watch(CatalogWatchError::Closed),
        watch(CatalogWatchError::Socket(Box::new(closed_1013))),
        watch(CatalogWatchError::Protocol(CatalogEventError::Unavailable)),
        watch(CatalogWatchError::Owner(DaemonError::IdentityChanged)),
    ] {
        assert_eq!(classify(&error), HomeFailure::Retry, "{error:?}");
    }
}

#[test]
fn malformed_data_counts_toward_the_protocol_limit() {
    for error in [
        DaemonError::IdentityFormat,
        DaemonError::ResourceFormat,
        watch(CatalogWatchError::Protocol(CatalogEventError::Frame)),
        watch(CatalogWatchError::Protocol(CatalogEventError::Identity)),
        watch(CatalogWatchError::Protocol(CatalogEventError::Retired)),
        watch(CatalogWatchError::Owner(DaemonError::ResourceFormat)),
    ] {
        assert_eq!(classify(&error), HomeFailure::Protocol, "{error:?}");
    }
}

#[test]
fn failures_that_cannot_recover_stop_with_their_reason() {
    for (error, says) in [
        (DaemonError::Incompatible(3), "needs an update"),
        (DaemonError::RecordFormat, "record is unreadable"),
        (DaemonError::RecordSecurity, "record is unreadable"),
        (DaemonError::Endpoint, "record is unreadable"),
        (
            DaemonError::RequestStatus(401),
            "refused this app's credentials",
        ),
        (
            DaemonError::RequestStatus(403),
            "refused this app's credentials",
        ),
        (
            watch(CatalogWatchError::Owner(DaemonError::Incompatible(9))),
            "needs an update",
        ),
    ] {
        match classify(&error) {
            HomeFailure::Fatal(message) => assert!(message.contains(says), "{error:?}: {message}"),
            other => panic!("{error:?} classified {other:?}"),
        }
    }
}

#[test]
fn backoff_doubles_to_a_cap_and_never_gives_up() {
    let start = Instant::now();
    let mut recovery = Recovery::default();
    let mut delays = Vec::new();
    let mut now = start;
    for _ in 0..12 {
        recovery.failed(HomeFailure::Retry, now).unwrap();
        let wait = recovery.wait(now).unwrap();
        delays.push(wait.as_millis());
        assert!(!recovery.due(now + wait - Duration::from_millis(1)));
        now += wait;
        assert!(recovery.due(now), "due after its wait");
        assert!(!recovery.due(now), "taken once");
    }
    assert_eq!(&delays[..6], &[250, 500, 1000, 2000, 4000, 5000]);
    assert!(delays[6..].iter().all(|d| *d == 5000));
    assert_eq!(recovery.attempt(), Some(12));
}

#[test]
fn retry_now_moves_only_a_waiting_attempt() {
    let now = Instant::now();
    let mut recovery = Recovery::default();
    recovery.retry_now(now);
    assert!(!recovery.active());
    recovery.failed(HomeFailure::Retry, now).unwrap();
    assert!(!recovery.due(now));
    recovery.retry_now(now);
    assert!(recovery.due(now));
}

#[test]
fn three_protocol_failures_in_a_row_stop_and_a_good_retry_resets_them() {
    let now = Instant::now();
    let mut recovery = Recovery::default();
    recovery.failed(HomeFailure::Protocol, now).unwrap();
    recovery.failed(HomeFailure::Protocol, now).unwrap();
    recovery.failed(HomeFailure::Retry, now).unwrap();
    recovery.failed(HomeFailure::Protocol, now).unwrap();
    recovery.failed(HomeFailure::Protocol, now).unwrap();
    assert!(
        recovery
            .failed(HomeFailure::Protocol, now)
            .unwrap_err()
            .contains("can't read")
    );
}

#[test]
fn a_fatal_failure_stops_at_once() {
    let now = Instant::now();
    let mut recovery = Recovery::default();
    let message = recovery.failed(HomeFailure::Fatal("why"), now).unwrap_err();
    assert_eq!(message, "why");
}
