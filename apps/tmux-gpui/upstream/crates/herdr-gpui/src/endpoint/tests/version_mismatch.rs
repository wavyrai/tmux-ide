use super::*;
use herdr_client::{VersionMismatch, protocol::endpoint::EndpointServerWelcome};

fn refuse(endpoint: &mut Endpoint, mismatch: VersionMismatch) {
    let mut inbox = endpoint.connection.inbox.lock().unwrap();
    inbox.apply(ClientEvent::VersionMismatch(mismatch));
    inbox.apply(ClientEvent::Disconnected {
        reason: "Herdr server 0.8.2 is too old".into(),
        ssh: None,
    });
}

#[test]
fn refusal_survives_retries_until_a_handshake_is_accepted() {
    let mut endpoint = Endpoint::new(LOCAL.into(), "Local".into(), ConnectTarget::Local, true);
    let mismatch = VersionMismatch::DaemonOutdated {
        server_version: Some("0.8.2".into()),
    };
    refuse(&mut endpoint, mismatch.clone());
    endpoint.poll(Instant::now());
    assert_eq!(endpoint.version_mismatch, Some(mismatch.clone()));
    assert_eq!(endpoint.status(), "Herdr update needed");

    // A retry replaces the bridge's state before the daemon answers again.
    endpoint.stop();
    endpoint.poll(Instant::now());
    assert!(endpoint.live.version_mismatch.is_none());
    assert_eq!(endpoint.version_mismatch, Some(mismatch));

    let welcome: EndpointServerWelcome = serde_json::from_str(include_str!(
        "../../../../herdr-protocol/tests/fixtures/endpoint-welcome-v1.json"
    ))
    .unwrap();
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Connected(welcome));
    endpoint.poll(Instant::now());
    assert_eq!(endpoint.version_mismatch, None);
    assert_eq!(endpoint.status(), "online");
}

#[test]
fn a_newer_daemon_asks_for_an_app_update_and_retargeting_forgets_it() {
    let mut endpoint = Endpoint::new(LOCAL.into(), "Local".into(), ConnectTarget::Local, true);
    refuse(
        &mut endpoint,
        VersionMismatch::ClientOutdated {
            server_version: None,
        },
    );
    endpoint.poll(Instant::now());
    assert_eq!(endpoint.status(), "app update needed");
    endpoint.retarget(ConnectTarget::Session {
        name: "other".into(),
        development: false,
    });
    assert_eq!(endpoint.version_mismatch, None);
}
