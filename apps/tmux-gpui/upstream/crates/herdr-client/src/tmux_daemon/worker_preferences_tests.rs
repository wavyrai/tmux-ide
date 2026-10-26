#![allow(clippy::unwrap_used)]
use super::*;
use std::{io::Write, net::TcpListener, os::unix::fs::OpenOptionsExt};
#[test]
fn replacement_owner_cannot_accept_a_previously_acknowledged_preference_action() {
    let sandbox = super::super::tests::Sandbox::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let path = sandbox.0.join("daemon.json");
    let mut value = serde_json::json!({"pid":123,"port":listener.local_addr().unwrap().port(),"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"first-fixture-secret"});
    let build = |value: &serde_json::Value| {
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(value.to_string().as_bytes())
            .unwrap();
        let (record, fingerprint) = super::super::record::read(&path).unwrap();
        super::super::LocalDaemon {
            base_url: record.endpoint().unwrap(),
            record,
            fingerprint,
            path: path.clone(),
            agent: super::super::agent(),
        }
    };
    let first = build(&value);
    let stamp = first.owner_stamp();
    value["authToken"] = "replacement-fixture-secret".into();
    let replacement = super::super::owner::Owner::Local(Arc::new(build(&value)));
    let result = execute(
        &replacement,
        &mut None,
        CatalogAction::FleetPreferences {
            change: Some((
                stamp,
                super::super::FleetPreferenceChange::Favorite {
                    key: "session".into(),
                    enabled: true,
                },
            )),
        },
        &Arc::new(AtomicBool::new(false)),
    );
    assert!(matches!(result, Err(Error::RecordChanged)));
    assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
}
