#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::tmux_daemon::CatalogWatchError;
fn failure() -> DaemonError {
    DaemonError::CatalogWatch(Box::new(CatalogWatchError::Timeout))
}
#[test]
fn delayed_attempts_are_bounded_and_require_fresh_authorization() {
    let now = Instant::now();
    let mut retries = Retries::default();
    let mut incarnation = uuid::Uuid::new_v4();
    for count in 0..3 {
        retries.failed("remote", incarnation, &failure(), now);
        let delay = Duration::from_secs(1 << count);
        assert_eq!(retries.wait(now), Some(delay));
        assert!(!retries.request(now + delay - Duration::from_millis(1)));
        assert!(retries.request(now + delay));
        assert!(retries.0["remote"].pending);
        assert_eq!(retries.0["remote"].count, count);
        assert!(!retries.request(now + delay));
        // Simulate only the fresh registry continuation authorizing a new source.
        let attempt = retries.0.get_mut("remote").unwrap();
        incarnation = uuid::Uuid::new_v4();
        attempt.incarnation = incarnation;
        attempt.count += 1;
        attempt.pending = false;
    }
    retries.failed("remote", incarnation, &failure(), now);
    assert_eq!(retries.wait(now), None);
    retries.success("remote");
    assert!(retries.0.is_empty());
}
#[test]
fn replacement_disconnect_and_authority_loss_revoke_pending_recovery() {
    let now = Instant::now();
    let incarnation = uuid::Uuid::new_v4();
    let mut retries = Retries::default();
    let labels = BTreeMap::from([("remote".into(), ("Remote".into(), incarnation))]);
    retries.failed("remote", incarnation, &failure(), now);
    retries.retain(&labels, &BTreeSet::new());
    assert_eq!(retries.0.len(), 1);
    retries.retain(&labels, &BTreeSet::from(["remote".into()]));
    assert!(retries.0.is_empty());
    retries.failed("remote", uuid::Uuid::new_v4(), &failure(), now);
    retries.retain(&labels, &BTreeSet::new());
    assert!(retries.0.is_empty());
    retries.failed("remote", incarnation, &failure(), now);
    retries.retain(&BTreeMap::new(), &BTreeSet::new());
    assert!(retries.0.is_empty());
}
#[test]
fn security_and_protocol_errors_never_schedule_recovery() {
    let mut retries = Retries::default();
    let inc = uuid::Uuid::new_v4();
    for error in [
        DaemonError::IdentityChanged,
        DaemonError::RecordSecurity,
        DaemonError::RequestStatus(401),
        DaemonError::ResourceFormat,
        DaemonError::Retired,
    ] {
        retries.failed("remote", inc, &failure(), Instant::now());
        retries.failed("remote", inc, &error, Instant::now());
        assert!(retries.0.is_empty());
    }
    #[cfg(unix)]
    {
        use herdr_client::tmux_ssh::{DiscoveryError, TransportError, TunnelError};
        for error in [
            TransportError::Discovery(DiscoveryError::Authentication),
            TransportError::Tunnel(TunnelError::HostKey),
        ] {
            assert!(!transient(&DaemonError::Remote(Box::new(error))));
        }
    }
}

#[test]
fn abrupt_socket_eof_is_transient_but_other_websocket_protocol_errors_are_not() {
    use tungstenite::{Error as SocketError, error::ProtocolError};
    let error = |kind| {
        DaemonError::CatalogWatch(Box::new(CatalogWatchError::Socket(Box::new(
            SocketError::Protocol(kind),
        ))))
    };
    assert!(transient(&error(
        ProtocolError::ResetWithoutClosingHandshake
    )));
    assert!(!transient(&error(ProtocolError::SendAfterClosing)));
}

#[test]
fn http_timeout_recovers_but_http_unauthorized_does_not() {
    assert!(transient(&DaemonError::Network(ureq::Error::Timeout(
        ureq::Timeout::Global
    ))));
    assert!(!transient(&DaemonError::Network(ureq::Error::StatusCode(
        401
    ))));
}
