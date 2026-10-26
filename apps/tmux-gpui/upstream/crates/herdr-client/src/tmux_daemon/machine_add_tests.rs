#![allow(clippy::unwrap_used)]
use super::*;
fn empty() -> SavedMachineRegistry {
    SavedMachineRegistry {
        version: 1,
        machines: vec![],
    }
}
#[test]
fn add_reuses_pinned_profile_and_refuses_disabled_or_ambiguous_target() {
    let mut registry = empty();
    let mut profile = registry.prepare_machine("build").unwrap();
    profile.expected_environment_id = Some(uuid::Uuid::new_v4().to_string());
    registry.machines.push(profile.clone());
    assert_eq!(registry.prepare_machine("build").unwrap(), profile);
    registry.machines[0].enabled = false;
    assert!(matches!(
        registry.prepare_machine("build"),
        Err(Error::MachineRegistryChanged)
    ));
    registry.machines[0].enabled = true;
    let mut duplicate = profile;
    duplicate.id = uuid::Uuid::new_v4().to_string();
    duplicate.label = "Other".into();
    registry.machines.push(duplicate);
    assert!(matches!(
        registry.prepare_machine("build"),
        Err(Error::MachineRegistryChanged)
    ));
}
#[test]
fn generated_labels_preserve_reserved_names_length_and_normalized_uniqueness() {
    let mut registry = empty();
    let local = registry.prepare_machine("Local").unwrap();
    assert_eq!(local.label, "Local (2)");
    registry.machines.push(local);
    assert_eq!(
        registry.prepare_machine("local").unwrap().label,
        "local (3)"
    );
    let alias = "x".repeat(255);
    let profile = registry.prepare_machine(&alias).unwrap();
    assert_eq!(profile.label.len(), 70);
    registry.machines.push(profile);
    let other = registry
        .prepare_machine(&format!("{}y", "x".repeat(254)))
        .unwrap();
    assert!(other.label.ends_with(" (2)"));
    for invalid in ["-oProxyCommand=evil", "host;cmd", "host\n", "", "host:22"] {
        assert!(registry.prepare_machine(invalid).is_err());
    }
}
#[test]
fn import_is_add_only_idempotent_and_bounded() {
    let empty = empty();
    let mut incoming = SavedMachineRegistry {
        version: 1,
        machines: vec![empty.prepare_machine("build").unwrap()],
    };
    let added = empty.merged(&incoming).unwrap();
    assert_eq!(added.merged(&incoming).unwrap(), added);
    incoming.machines[0].ssh_target = "changed".into();
    assert!(matches!(
        added.merged(&incoming),
        Err(Error::MachineRegistryChanged)
    ));
    incoming.machines[0].id = uuid::Uuid::new_v4().to_string();
    assert!(added.merged(&incoming).is_err());
    let mut full = empty.clone();
    for i in 0..64 {
        full.machines
            .push(empty.prepare_machine(&format!("host{i}")).unwrap());
    }
    assert!(full.clone().validated().is_ok());
    assert!(full.merged(&added).is_err());
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
        Save,
        LostCommitted,
        LostAbsent,
        Disabled,
        Cancelled,
    }
    fn journey(scenario: Scenario) {
        let lost = matches!(scenario, Scenario::LostCommitted | Scenario::LostAbsent);
        let committed = matches!(
            scenario,
            Scenario::Save | Scenario::LostCommitted | Scenario::Disabled
        );
        let disabled = matches!(scenario, Scenario::Disabled);
        let cancel_before_write = matches!(scenario, Scenario::Cancelled);
        let cancellation = Arc::new(AtomicBool::new(false));
        let cancel = cancellation.clone();
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
        let posts = Arc::new(Mutex::new(0));
        let observed = posts.clone();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut registry = empty();
            let mut reads = 0;
            for _ in 0..if cancel_before_write {
                6
            } else if lost {
                10
            } else {
                11
            } {
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
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
                let mut bytes = Vec::new();
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
                    let mut value = record.clone();
                    value["ok"] = true.into();
                    value
                } else {
                    assert!(headers.contains("Bearer fixture-secret"));
                    if headers.starts_with("POST ") {
                        *observed.lock().unwrap() += 1;
                        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                        assert_eq!(body["expectedInstanceId"], record["instanceId"]);
                        if committed {
                            registry = serde_json::from_value(body["registry"].clone()).unwrap();
                            if disabled {
                                registry.machines[0].enabled = false;
                            }
                        }
                        if lost {
                            continue;
                        }
                    } else {
                        assert!(headers.starts_with("GET /api/resources/saved-machines "));
                        reads += 1;
                        if cancel_before_write && reads == 2 {
                            cancel.store(true, Ordering::Release);
                        }
                    }
                    serde_json::json!({"daemon":{"protocolVersion":4,"productVersion":record["productVersion"],"instanceId":record["instanceId"],"startedAt":record["startedAt"]},"registry":registry})
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
        let result = owner.prepare_machine_connection("target", &cancellation);
        server.join().unwrap();
        assert_eq!(*posts.lock().unwrap(), usize::from(!cancel_before_write));
        if cancel_before_write {
            assert!(matches!(result, Err(Error::Retired)));
        } else if disabled {
            assert!(matches!(result, Err(Error::MachineRegistryChanged)));
        } else {
            assert_eq!(result.unwrap().persisted, committed);
        }
    }
    #[test]
    fn add_saves_once_and_reads_back_authority() {
        journey(Scenario::Save);
    }
    #[test]
    fn lost_save_receipt_reconciles_committed_profile_without_retry() {
        journey(Scenario::LostCommitted);
    }
    #[test]
    fn absent_save_uses_ephemeral_profile_without_replaying() {
        journey(Scenario::LostAbsent);
    }
    #[test]
    fn concurrent_disable_never_becomes_unpinned_ephemeral_route() {
        journey(Scenario::Disabled);
    }
    #[test]
    fn cancellation_during_preflight_sends_no_save_request() {
        journey(Scenario::Cancelled);
    }
}
