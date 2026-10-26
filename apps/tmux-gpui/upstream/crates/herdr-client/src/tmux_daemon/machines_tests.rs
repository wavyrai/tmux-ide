#![allow(clippy::unwrap_used)]
use super::*;
fn registry() -> SavedMachineRegistry {
    SavedMachineRegistry {
        version: 1,
        machines: vec![SavedMachine {
            id: "D9C81EBD-5785-45A3-9206-A2AA497D68FC".into(),
            label: "  Build Mac  ".into(),
            ssh_target: "user@[::1]".into(),
            expected_environment_id: None,
            enabled: true,
        }],
    }
}
#[test]
fn canonical_profiles_preserve_identity_pin_and_disabled_state() {
    let mut value = registry();
    value.machines[0].expected_environment_id = Some(value.machines[0].id.clone());
    value.machines[0].enabled = false;
    let value = value.validated().unwrap();
    assert_eq!(value.machines[0].label, "Build Mac");
    assert_eq!(
        value.machines[0].expected_environment_id.as_ref().unwrap(),
        &value.machines[0].id
    );
    assert!(value.select(&value.machines[0].id).is_none());
}
#[test]
fn rejects_unicode_alias_collisions_controls_and_shell_targets() {
    for label in [
        "Ｌｏｃａｌ",
        "LOCAL",
        "\u{202e}Build",
        "\u{200b}Build",
        "\n",
    ] {
        let mut value = registry();
        value.machines[0].label = label.into();
        assert!(value.validated().is_err(), "{label:?}");
    }
    for target in [
        "-oProxyCommand=evil",
        "host;cmd",
        "host\n",
        "user@host:22",
        "$(cmd)",
    ] {
        let mut value = registry();
        value.machines[0].ssh_target = target.into();
        assert!(value.validated().is_err());
    }
    let mut value = registry();
    let mut second = value.machines[0].clone();
    second.id = uuid::Uuid::new_v4().to_string();
    second.label = "Ｂｕｉｌｄ Ｍａｃ".into();
    value.machines.push(second);
    assert!(value.validated().is_err());
}
#[test]
fn rejects_unknown_fields_and_empty_edits() {
    assert!(
        serde_json::from_value::<SavedMachineRegistry>(
            serde_json::json!({"version":1,"machines":[],"token":"no"})
        )
        .is_err()
    );
    let value = registry().validated().unwrap();
    assert!(
        MachineChange::Edit {
            id: value.machines[0].id.clone(),
            patch: MachinePatch::default()
        }
        .validate(&value)
        .is_err()
    );
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
        Success,
        Stale,
        LostReceipt,
    }
    fn journey(scenario: Scenario) -> (Result<SavedMachineRegistry, Error>, Vec<String>) {
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
        let expected = registry().validated().unwrap();
        let mut changed = expected.clone();
        changed.machines[0].enabled = false;
        let observed = Arc::new(Mutex::new(Vec::new()));
        let requests = observed.clone();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let count = match scenario {
                Scenario::Success => 9,
                Scenario::Stale => 7,
                Scenario::LostReceipt => 8,
            };
            let mut reads = 0;
            for _ in 0..count {
                let (mut socket, _) = loop {
                    match listener.accept() {
                        Ok(value) => break value,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline);
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(error) => panic!("{error}"),
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
                let line = headers.lines().next().unwrap().to_owned();
                requests.lock().unwrap().push(line.clone());
                let response = if line.starts_with("GET /identity ") {
                    assert!(!headers.to_lowercase().contains("authorization:"));
                    let mut identity = record.clone();
                    identity["ok"] = true.into();
                    identity
                } else {
                    assert!(headers.contains("Bearer fixture-secret"));
                    let selected = if line.starts_with("PATCH ") {
                        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                        assert_eq!(body["expectedInstanceId"], record["instanceId"]);
                        assert_eq!(body["change"]["operation"], "disable");
                        if matches!(scenario, Scenario::LostReceipt) {
                            continue;
                        }
                        &changed
                    } else {
                        assert!(line.starts_with("GET /api/resources/saved-machines "));
                        reads += 1;
                        if reads == 2 && matches!(scenario, Scenario::Stale) {
                            &changed
                        } else {
                            &expected
                        }
                    };
                    serde_json::json!({"daemon":{"protocolVersion":4,"productVersion":record["productVersion"],"instanceId":record["instanceId"],"startedAt":record["startedAt"]},"registry":selected})
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
        let owner = LocalDaemon::discover(&path).unwrap();
        let before = owner.saved_machines().unwrap();
        let result = owner.mutate_saved_machine(
            &before,
            &MachineChange::Disable {
                id: before.machines[0].id.clone(),
            },
        );
        server.join().unwrap();
        let requests = observed.lock().unwrap().clone();
        (result, requests)
    }
    #[test]
    fn mutation_sends_once_with_verified_local_owner() {
        let (result, requests) = journey(Scenario::Success);
        assert!(!result.unwrap().machines[0].enabled);
        assert_eq!(
            requests.iter().filter(|r| r.starts_with("PATCH ")).count(),
            1
        );
    }
    #[test]
    fn changed_registry_prevents_write() {
        let (result, requests) = journey(Scenario::Stale);
        assert!(matches!(result, Err(Error::MachineRegistryChanged)));
        assert!(!requests.iter().any(|r| r.starts_with("PATCH ")));
    }
    #[test]
    fn lost_receipt_is_uncertain_without_retry() {
        let (result, requests) = journey(Scenario::LostReceipt);
        assert!(matches!(result, Err(Error::MachineMutationUncertain(_))));
        assert_eq!(
            requests.iter().filter(|r| r.starts_with("PATCH ")).count(),
            1
        );
    }
}
