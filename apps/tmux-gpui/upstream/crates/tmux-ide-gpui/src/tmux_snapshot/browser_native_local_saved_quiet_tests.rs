//! #853, review round 1 of PR #475: what a saved machine's quiet reload must
//! still stop on, and what a failed quiet try must not leave behind.
use super::*;
use herdr_client::tmux_daemon::Error as E;
use herdr_client::tmux_ssh::{DiscoveryError, Error as SshError, TransportError};
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
};

const ENVIRONMENT: &str = "33333333-3333-4333-8333-333333333333";

fn another_environment() -> E {
    E::Remote(Box::new(TransportError::Discovery(
        DiscoveryError::Descriptor(SshError::Environment),
    )))
}

/// A saved machine pinned to the environment it was saved with, selected,
/// with its catalog not read yet.
fn pinned_machine_home() -> (Local, mpsc::Receiver<Incoming>) {
    let (mut local, events) = fixture();
    local.active = None;
    local.state.selected_session = None;
    local.state.selected_pane = None;
    let target = herdr_client::tmux_ssh::SshTarget::parse("fixture.invalid").unwrap();
    local.sources = NativeOwner::new(CatalogSource::remote(target, Some(ENVIRONMENT.into())));
    local.machine_id = build_machine().id;
    local.selected_profile = Some(herdr_client::tmux_daemon::SavedMachine {
        expected_environment_id: Some(ENVIRONMENT.into()),
        ..build_machine()
    });
    (local, events)
}

/// Item 1: a saved machine that answered as another environment stops at
/// once, as recovery does over SSH, and is not tried again by itself.
#[test]
fn a_saved_machine_that_answered_as_another_environment_stops_and_is_not_retried() {
    // The first load.
    let (mut local, events) = pinned_machine_home();
    local
        .stage_failed(Stage::Servers, &another_environment())
        .unwrap();
    assert!(
        local.home.quiet.wait(Instant::now()).is_none(),
        "a saved machine that answered as another environment is tried again by itself"
    );
    assert_eq!(local.state.home_phase, HomePhase::Unavailable);
    assert_eq!(last_catalog(&events).status, SSH_IDENTITY);
    // A quiet try: the machine began answering as another environment after
    // an earlier try failed for another reason.
    let (mut local, events) = pinned_machine_home();
    local.stage_failed(Stage::Servers, &E::OwnerExited).unwrap();
    assert!(local.home.quiet.due_now());
    local.quiet_tick().unwrap();
    assert!(local.home.quiet.probing());
    local.stage = None;
    local.quiet_failed(&another_environment()).unwrap();
    assert!(
        local.home.quiet.wait(Instant::now()).is_none(),
        "a quiet try that met another environment is tried again"
    );
    assert!(!local.home.quiet.probing());
    assert_eq!(local.state.home_phase, HomePhase::Unavailable);
    assert_eq!(last_catalog(&events).status, SSH_IDENTITY);
}

/// Only that answer stops: a machine that is away, slow or cut off, or that
/// sent a bad descriptor, is retried (#363 review, S10).
#[test]
fn a_saved_machine_that_is_only_away_is_still_retried() {
    let away = |error| E::Remote(Box::new(TransportError::Discovery(error)));
    for error in [
        away(DiscoveryError::Unreachable),
        away(DiscoveryError::Timeout),
        away(DiscoveryError::Descriptor(SshError::Descriptor)),
        E::IdentityChanged,
    ] {
        let (mut local, _events) = pinned_machine_home();
        local.stage_failed(Stage::Servers, &error).unwrap();
        assert!(local.home.quiet.wait(Instant::now()).is_some(), "{error}");
        let profile = local.selected_profile.clone().unwrap();
        assert!(verified(&mut local, vec![profile]));
        local.stage = None;
        local.quiet_failed(&error).unwrap();
        assert!(local.home.quiet.wait(Instant::now()).is_some(), "{error}");
        assert_ne!(local.state.status, SSH_IDENTITY);
    }
}

/// Item 2, A8: a machine selected while a quiet try is under way is a
/// selection, not a quiet try. Its failed verification says so.
#[test]
fn a_machine_selected_while_a_quiet_try_runs_fails_as_a_selection() {
    let (mut local, _events) = stopped_saved_machine();
    // The quiet try verified the machine and now reads its catalog.
    assert!(verified(&mut local, vec![build_machine()]));
    assert!(local.home.quiet.probing());
    let request = local.state.request + 1;
    let revision = local.registry.publication().revision;
    local
        .select_machine(request, build_machine().id, revision)
        .unwrap();
    let stage = local.stage.take().unwrap();
    assert!(matches!(stage, Stage::MachineSelection { .. }));
    assert!(!local.home.quiet.probing(), "the selection is a quiet try");
    local.registry_stage_failed(&stage, E::OwnerExited).unwrap();
    assert_eq!(
        local.state.status,
        "Saved machine verification failed — refresh and select it again"
    );
    assert_eq!(local.state.home_phase, HomePhase::Unavailable);
}

/// A local daemon for the registry read: a private record and a loopback
/// listener that answers `/identity` and, when `registry` is set, the saved
/// machines; any other request gets a 500. It serves until `deadline`.
struct Daemon(tempfile::TempDir);
impl Daemon {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(dir)
    }
    fn record(&self) -> PathBuf {
        self.0.path().join("daemon.json")
    }
    /// Starts a daemon generation and writes its record over the last one.
    fn start(&self, instance: &str, registry: Option<serde_json::Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let identity = serde_json::json!({
            "protocolVersion": 4,
            "productVersion": "2.9.12",
            "instanceId": instance,
            "startedAt": "2026-11-25T12:00:00Z",
        });
        let mut record = identity.clone();
        record["pid"] = std::process::id().into();
        record["port"] = port.into();
        record["bindHostname"] = "127.0.0.1".into();
        record["authToken"] = "fixture-token".into();
        let mut proof = identity.clone();
        proof["ok"] = true.into();
        proof["pid"] = std::process::id().into();
        let resource =
            registry.map(|registry| serde_json::json!({"daemon": identity, "registry": registry}));
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut head = Vec::new();
                let mut byte = [0];
                while !head.ends_with(b"\r\n\r\n") && socket.read_exact(&mut byte).is_ok() {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head);
                let path = head.split_whitespace().nth(1).unwrap_or_default();
                let body = match (path, &resource) {
                    ("/identity", _) => Some(proof.to_string()),
                    ("/api/resources/saved-machines", Some(resource)) => Some(resource.to_string()),
                    _ => None,
                };
                let reply = match body {
                    Some(body) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    None => "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
                };
                let _ = socket.write_all(reply.as_bytes());
            }
        });
        let path = self.record();
        let staged = self.0.path().join("daemon.json.next");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staged)
            .unwrap();
        file.write_all(record.to_string().as_bytes()).unwrap();
        drop(file);
        std::fs::rename(staged, path).unwrap();
    }
}
/// Runs the quiet try's registry read on the window's own registry worker,
/// as `turn()` does, and hands its answer back the way `turn()` does.
fn quiet_verification(local: &mut Local) -> bool {
    assert!(local.home.quiet.due_now());
    local.quiet_tick().unwrap();
    let stage = local.stage.take().unwrap();
    assert!(matches!(stage, Stage::VerifyProfile));
    let worker = local.registry_worker.as_mut().unwrap();
    worker.submit(stage.action()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let result = loop {
        if let Some(result) = worker.poll().unwrap() {
            break result;
        }
        assert!(Instant::now() < deadline, "the registry read never ended");
        std::thread::sleep(Duration::from_millis(5));
    };
    match result {
        Ok(result) => {
            local.completed(stage, result).unwrap();
            matches!(local.stage, Some(Stage::Servers))
        }
        Err(error) => {
            local.registry_stage_failed(&stage, error).unwrap();
            false
        }
    }
}

/// Item 2, A10: the quiet verification failed, then the local daemon was
/// replaced (a new record). The next quiet try reads the new record, verifies
/// the machine and reads its catalog; it does not keep asking the daemon
/// that is gone.
#[test]
fn a_quiet_verification_after_the_local_daemon_was_replaced_verifies_and_reads() {
    let daemon = Daemon::new();
    // The first daemon answers its identity but fails the registry read.
    daemon.start("d9c81ebd-5785-45a3-9206-a2aa497d68fc", None);
    let (mut local, _events) = stopped_saved_machine();
    local.local_record = Some(daemon.record());
    local.registry_worker = Some(CatalogWorker::spawn(daemon.record()).unwrap());
    assert!(!quiet_verification(&mut local));
    assert!(local.selected_profile.is_some());
    assert!(local.home.quiet.wait(Instant::now()).is_some());
    // launchd brought a new daemon: a new record, a new port.
    let registry = serde_json::json!({"version": 1, "machines": [build_machine()]});
    daemon.start("e5f2a3b4-1111-4c22-9d33-444455556666", Some(registry));
    assert!(
        quiet_verification(&mut local),
        "the quiet try kept asking the daemon that was gone"
    );
    assert!(local.selected_profile.is_some());
}
