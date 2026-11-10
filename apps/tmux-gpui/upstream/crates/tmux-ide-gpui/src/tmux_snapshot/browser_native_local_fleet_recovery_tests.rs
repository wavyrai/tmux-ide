#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::tmux_daemon::CatalogWatchError;
fn failure() -> DaemonError {
    DaemonError::CatalogWatch(Box::new(CatalogWatchError::Timeout))
}
#[test]
fn an_unreachable_machine_is_retried_until_disconnected_with_a_capped_backoff() {
    let now = Instant::now();
    let mut retries = Retries::default();
    let mut incarnation = uuid::Uuid::new_v4();
    let mut delays = Vec::new();
    for count in 0..10u32 {
        retries.failed("remote", incarnation, &failure(), now);
        let delay = retries.wait(now).unwrap();
        delays.push(delay.as_secs());
        assert!(!retries.request(now + delay - Duration::from_millis(1)));
        assert!(retries.request(now + delay));
        assert!(retries.0["remote"].pending);
        assert_eq!(retries.0["remote"].count, count);
        assert!(!retries.request(now + delay));
        // Only the fresh registry continuation authorizes a new source.
        let attempt = retries.0.get_mut("remote").unwrap();
        incarnation = uuid::Uuid::new_v4();
        attempt.incarnation = incarnation;
        attempt.count += 1;
        attempt.pending = false;
    }
    // 1, 2, 4… seconds, capped at a minute, and it keeps going.
    assert_eq!(delays, [1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
    assert!(retries.away("remote").is_some_and(|(at, _)| at == now));
    retries.success("remote");
    assert!(retries.0.is_empty());
    assert!(retries.away("remote").is_none());
}
#[test]
fn the_delay_never_exceeds_a_minute() {
    for count in [0, 5, 6, 7, 16, 63, u32::MAX] {
        assert!(delay(count) <= MAX_DELAY, "{count}");
    }
    assert_eq!(delay(0), Duration::from_secs(1));
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
