#![allow(clippy::unwrap_used)]
use super::*;
fn state() -> FleetClientState {
    FleetClientState {
        version: 1,
        favorites: vec![],
        collapsed: vec![],
        recent: vec![],
        catalog: vec![],
    }
}
fn route() -> FleetCachedRoute {
    FleetCachedRoute {
        route_id: "local".into(),
        environment_id: None,
        generation: None,
        seen_at: 0,
        sessions: vec![FleetCachedSession {
            id: "session-key".into(),
            live_session_id: None,
            server: None,
            server_label: None,
            name: "Build".into(),
            pane_count: 1,
        }],
    }
}
#[test]
fn canonical_roundtrip_normalizes_only_machine_route_ids() {
    let mut value = state();
    let mut entry = route();
    entry.route_id = "D9C81EBD-5785-45A3-9206-A2AA497D68FC".into();
    entry.environment_id = Some(entry.route_id.clone());
    entry.sessions[0].server = Some(ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: uuid::Uuid::new_v4().to_string(),
    });
    value.catalog.push(entry);
    let parsed: FleetClientState =
        serde_json::from_slice(&serde_json::to_vec(&value).unwrap()).unwrap();
    let parsed = parsed.validated().unwrap();
    assert_eq!(
        parsed.catalog[0].route_id,
        "d9c81ebd-5785-45a3-9206-a2aa497d68fc"
    );
    assert_eq!(
        parsed.catalog[0].environment_id,
        value.catalog[0].environment_id
    );
}
#[test]
fn rejects_control_format_unicode_length_capacity_and_bad_scope() {
    for text in [
        "\u{202e}bad".into(),
        "\u{0085}".into(),
        "x".repeat(1025),
        "😀".repeat(513),
    ] {
        let mut value = state();
        value.favorites.push(text);
        assert!(value.validated().is_err());
    }
    let mut value = state();
    value.favorites = vec!["valid".into(); 129];
    assert!(value.validated().is_err());
    let mut entry = route();
    entry.seen_at = SAFE_INTEGER + 1;
    assert!(!entry.valid());
    entry = route();
    entry.sessions[0].pane_count = 4097;
    assert!(!entry.valid());
    entry = route();
    entry.sessions[0].server = Some(ServerScope {
        server_id: "wrong".into(),
        generation: uuid::Uuid::new_v4().to_string(),
    });
    assert!(!entry.valid());
}
#[test]
fn required_nullable_fields_are_not_optional_and_unknown_fields_are_rejected() {
    let mut value = serde_json::to_value(route()).unwrap();
    value.as_object_mut().unwrap().remove("generation");
    assert!(serde_json::from_value::<FleetCachedRoute>(value).is_err());
    let mut value = serde_json::to_value(route()).unwrap();
    value["sessions"][0]["liveSessionId"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<FleetCachedRoute>(value).is_err());
    let mut value = serde_json::to_value(state()).unwrap();
    value["ownerToken"] = "no".into();
    assert!(serde_json::from_value::<FleetClientState>(value).is_err());
    assert!(
        FleetPreferenceChange::Visit { key: "\n".into() }
            .validate()
            .is_err()
    );
    assert!(
        FleetPreferenceChange::ForgetRoute {
            route_id: "host".into()
        }
        .validate()
        .is_err()
    );
}
#[test]
fn uuid_validation_matches_the_pinned_contract_not_just_hex_shape() {
    for bad in [
        "d9c81ebd-5785-95a3-9206-a2aa497d68fc",
        "d9c81ebd-5785-45a3-7206-a2aa497d68fc",
        "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
    ] {
        assert!(!uuid(bad));
    }
    assert!(uuid("00000000-0000-0000-0000-000000000000"));
    assert!(uuid("ffffffff-ffff-ffff-ffff-ffffffffffff"));
    assert!(uuid("D9C81EBD-5785-45A3-9206-A2AA497D68FC"));
}
#[test]
fn nullable_environment_cannot_masquerade_as_omitted_owner_identity() {
    let resource = serde_json::json!({"daemon":{
        "protocolVersion":4,"productVersion":"2.9.12",
        "instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc",
        "startedAt":"2026-10-25T02:00:00Z", "environmentId":null
    },"state":state()});
    assert!(serde_json::from_value::<Resource>(resource).is_err());
}
#[cfg(unix)]
mod network {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        os::unix::fs::OpenOptionsExt,
        sync::{Arc, Mutex},
        thread,
        time::Instant,
    };
    enum Scenario {
        Read,
        LargeRead,
        Write,
        Lost,
        Generation,
        Cancel,
    }
    fn journey(scenario: Scenario) {
        let sandbox = crate::tmux_daemon::tests::Sandbox::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let record = serde_json::json!({"pid":123,"port":listener.local_addr().unwrap().port(),"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"fixture-secret"});
        let path = sandbox.0.join("daemon.json");
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(record.to_string().as_bytes())
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let writes = Arc::new(Mutex::new(0));
        let observed = writes.clone();
        let read = matches!(scenario, Scenario::Read | Scenario::LargeRead);
        let large = matches!(scenario, Scenario::LargeRead);
        let lost = matches!(scenario, Scenario::Lost);
        let generation = matches!(scenario, Scenario::Generation);
        let cancel = matches!(scenario, Scenario::Cancel);
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            for _ in 0..if cancel {
                1
            } else if lost {
                2
            } else {
                3
            } {
                let mut socket = loop {
                    match listener.accept() {
                        Ok((s, _)) => break s,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline);
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = vec![];
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut b = [0];
                    socket.read_exact(&mut b).unwrap();
                    bytes.push(b[0]);
                    assert!(bytes.len() < 8192);
                }
                let headers = String::from_utf8(bytes).unwrap();
                let length = headers
                    .lines()
                    .find_map(|l| {
                        l.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                socket.read_exact(&mut body).unwrap();
                let response = if headers.starts_with("GET /identity ") {
                    assert!(!headers.to_lowercase().contains("authorization:"));
                    if cancel {
                        stop.store(true, Ordering::Release);
                    }
                    let mut value = record.clone();
                    value["ok"] = true.into();
                    value
                } else {
                    assert!(headers.contains("Bearer fixture-secret"));
                    if read {
                        assert!(headers.starts_with("GET /api/resources/fleet-client-state "));
                    } else {
                        assert!(headers.starts_with("POST /api/resources/fleet-client-state "));
                        *observed.lock().unwrap() += 1;
                        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                        assert_eq!(body["expectedInstanceId"], record["instanceId"]);
                        assert_eq!(body["change"]["type"], "favorite");
                        if lost {
                            continue;
                        }
                    }
                    let mut value = state();
                    value.favorites.push("session-key".into());
                    if large {
                        let mut cached = route();
                        cached.sessions[0].id = "i".repeat(1024);
                        cached.sessions[0].live_session_id = Some("l".repeat(1024));
                        cached.sessions[0].name = "n".repeat(255);
                        cached.sessions = vec![cached.sessions[0].clone(); 64];
                        value.catalog = vec![cached; 8];
                        assert!(serde_json::to_vec(&value).unwrap().len() > 1024 * 1024);
                    }
                    let mut identity = serde_json::json!({"protocolVersion":4,"productVersion":record["productVersion"],"instanceId":record["instanceId"],"startedAt":record["startedAt"]});
                    if generation {
                        identity["instanceId"] = uuid::Uuid::new_v4().to_string().into();
                    }
                    serde_json::json!({"daemon":identity,"state":value})
                };
                let body = response.to_string();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let (record, fingerprint) = crate::tmux_daemon::record::read(&path).unwrap();
        let owner = LocalDaemon {
            base_url: record.endpoint().unwrap(),
            record,
            fingerprint,
            path,
            agent: crate::tmux_daemon::agent(),
        };
        let result = if read {
            owner.fleet_preferences()
        } else {
            owner.change_fleet_preference(
                &FleetPreferenceChange::Favorite {
                    key: "session-key".into(),
                    enabled: true,
                },
                &cancelled,
            )
        };
        server.join().unwrap();
        assert_eq!(*writes.lock().unwrap(), usize::from(!read && !cancel));
        if cancel {
            assert!(matches!(result, Err(Error::Retired)));
        } else if lost || generation {
            assert!(matches!(result, Err(Error::FleetMutationUncertain(_))));
        } else {
            let value = result.unwrap();
            assert_eq!(value.favorites, vec!["session-key"]);
            if large {
                assert_eq!(value.catalog.len(), 8);
            }
        }
    }
    #[test]
    fn reads_local_preferences_with_verified_identity() {
        journey(Scenario::Read);
    }
    #[test]
    fn writes_once_with_daemon_generation() {
        journey(Scenario::Write);
    }
    #[test]
    fn lost_receipt_is_uncertain_without_retry() {
        journey(Scenario::Lost);
    }
    #[test]
    fn replaced_response_identity_cannot_acknowledge_write() {
        journey(Scenario::Generation);
    }
    #[test]
    fn cancellation_during_identity_proof_prevents_write() {
        journey(Scenario::Cancel);
    }
    #[test]
    fn valid_large_catalog_is_not_truncated_by_small_resource_limit() {
        journey(Scenario::LargeRead);
    }
}
