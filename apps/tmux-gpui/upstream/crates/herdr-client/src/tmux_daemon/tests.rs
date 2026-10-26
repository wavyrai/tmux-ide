#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    thread,
    time::Instant,
};

pub(super) struct Sandbox(pub(super) PathBuf);
impl Sandbox {
    pub(super) fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("tmux-native-discovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn record(&self, value: &serde_json::Value) -> PathBuf {
        let path = self.0.join("daemon.json");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(value.to_string().as_bytes()).unwrap();
        path
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn value(port: u16) -> serde_json::Value {
    serde_json::json!({"pid":123,"port":port,"protocolVersion":4,"productVersion":"2.9.12", "instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc", "startedAt":"2026-10-24T12:00:00Z", "bindHostname":"127.0.0.1", "authToken":"must-never-be-sent-to-identity"})
}
fn identity() -> serde_json::Value {
    let mut v = value(1);
    v.as_object_mut().unwrap().remove("authToken");
    v["ok"] = true.into();
    v
}
fn response(value: &serde_json::Value) -> String {
    let body = value.to_string();
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
fn peer(reply: impl FnOnce() -> String + Send + 'static) -> (u16, thread::JoinHandle<String>) {
    let mut reply = Some(reply);
    peer_many(1, move |_| reply.take().unwrap()())
}
fn peer_many(
    count: usize,
    mut reply: impl FnMut(usize) -> String + Send + 'static,
) -> (u16, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let worker = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut requests = String::new();
        for index in 0..count {
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline);
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 16384);
            }
            let headers = String::from_utf8(bytes.clone()).unwrap();
            let length = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
            assert!(length <= 16384);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).unwrap();
            bytes.extend(body);
            socket.write_all(reply(index).as_bytes()).unwrap();
            requests.push_str(&String::from_utf8(bytes).unwrap());
        }
        requests
    });
    (port, worker)
}

#[test]
fn discovers_without_disclosing_owner_credentials() {
    let (port, worker) = peer(|| response(&identity()));
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let daemon = LocalDaemon::discover(&path).unwrap();
    assert_eq!(daemon.product_version(), "2.9.12");
    let request = worker.join().unwrap();
    assert!(request.starts_with("GET /identity HTTP/1.1"));
    assert!(!request.to_lowercase().contains("authorization"));
    assert!(!request.contains("must-never"));
}

#[test]
fn refuses_identity_mismatch_and_unknown_protocol_without_credentials() {
    for incompatible in [false, true] {
        let mut record = value(1);
        let mut answer = identity();
        if incompatible {
            record["protocolVersion"] = 999.into();
            answer["protocolVersion"] = 999.into();
        } else {
            answer["pid"] = 124.into();
        }
        let (port, worker) = peer(move || response(&answer));
        record["port"] = port.into();
        let sandbox = Sandbox::new();
        let path = sandbox.record(&record);
        let result = LocalDaemon::discover(&path);
        assert!(if incompatible {
            matches!(result, Err(Error::Incompatible(999)))
        } else {
            matches!(result, Err(Error::IdentityChanged))
        });
        assert!(!worker.join().unwrap().contains("must-never"));
    }
}

#[test]
fn replacement_during_probe_invalidates_proof() {
    let sandbox = Sandbox::new();
    let path = sandbox.0.join("daemon.json");
    let changed = path.clone();
    let (port, worker) = peer(move || {
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&changed).unwrap()).unwrap();
        record["authToken"] = "replacement".into();
        fs::write(&changed, record.to_string()).unwrap();
        response(&identity())
    });
    sandbox.record(&value(port));
    assert!(matches!(
        LocalDaemon::discover(&path),
        Err(Error::RecordChanged)
    ));
    worker.join().unwrap();
}

#[test]
fn refuses_redirects_and_oversized_identity() {
    for reply in [
        "HTTP/1.1 302 Found\r\nLocation: http://example.invalid/\r\nContent-Length: 0\r\n\r\n"
            .to_owned(),
        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", LIMIT + 1),
    ] {
        let (port, worker) = peer(move || reply);
        let sandbox = Sandbox::new();
        let path = sandbox.record(&value(port));
        assert!(LocalDaemon::discover(&path).is_err());
        worker.join().unwrap();
    }
}

#[test]
fn record_permissions_links_and_bounds_are_checked_before_network() {
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(1));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        LocalDaemon::discover(&path),
        Err(Error::RecordSecurity)
    ));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let link = sandbox.0.join("link");
    symlink(&path, &link).unwrap();
    assert!(LocalDaemon::discover(&link).is_err());
    fs::hard_link(&path, sandbox.0.join("hardlink")).unwrap();
    assert!(matches!(
        LocalDaemon::discover(&path),
        Err(Error::RecordSecurity)
    ));
    fs::remove_file(sandbox.0.join("hardlink")).unwrap();
    fs::write(&path, vec![b' '; LIMIT as usize + 1]).unwrap();
    assert!(matches!(
        LocalDaemon::discover(&path),
        Err(Error::RecordSecurity)
    ));
}

#[test]
fn remote_endpoints_and_reservations_are_not_local_authority() {
    for host in [
        "example.com",
        "127.0.0.1.evil",
        "127.0.0.1/path",
        "user@localhost",
    ] {
        let sandbox = Sandbox::new();
        let mut record = value(1);
        record["bindHostname"] = host.into();
        assert!(matches!(
            LocalDaemon::discover(&sandbox.record(&record)),
            Err(Error::Endpoint)
        ));
    }
    let sandbox = Sandbox::new();
    let mut record = value(1);
    record["kind"] = "supervised-reservation".into();
    assert!(matches!(
        LocalDaemon::discover(&sandbox.record(&record)),
        Err(Error::RecordFormat)
    ));
}

#[test]
fn identity_agent_disables_proxy_and_redirects() {
    let agent = agent();
    assert!(agent.config().proxy().is_none());
    assert_eq!(agent.config().max_redirects(), 0);
}

#[test]
fn owner_catalog_uses_credentials_only_after_identity_and_rejects_retired_record() {
    let (port, worker) = peer_many(2, |index| {
        if index == 0 {
            response(&identity())
        } else {
            response(&serde_json::json!({"version":1,"servers":[]}))
        }
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let daemon = LocalDaemon::discover(&path).unwrap();
    assert!(daemon.list_servers().unwrap().is_empty());
    let requests = worker.join().unwrap();
    assert_eq!(
        requests.matches("must-never-be-sent-to-identity").count(),
        1
    );
    let (probe, owner) = requests.split_once("GET /api/v1/tmux-servers").unwrap();
    assert!(!probe.to_lowercase().contains("authorization"));
    assert!(owner.contains("Bearer must-never-be-sent-to-identity"));
    let mut changed = value(port);
    changed["authToken"] = "new-owner".into();
    fs::write(path, changed.to_string()).unwrap();
    assert!(matches!(daemon.list_servers(), Err(Error::RecordChanged)));
}

#[test]
fn catalog_response_cannot_survive_owner_replacement() {
    let sandbox = Sandbox::new();
    let path = sandbox.0.join("daemon.json");
    let changed = path.clone();
    let (port, worker) = peer_many(2, move |index| {
        if index == 0 {
            response(&identity())
        } else {
            fs::write(&changed, b"{}").unwrap();
            response(&serde_json::json!({"version":1,"servers":[]}))
        }
    });
    sandbox.record(&value(port));
    let daemon = LocalDaemon::discover(&path).unwrap();
    assert!(matches!(daemon.list_servers(), Err(Error::RecordFormat)));
    worker.join().unwrap();
}

#[test]
fn nullable_and_malformed_record_fields_do_not_mint_authority() {
    for (key, field) in [
        ("kind", serde_json::Value::Null),
        ("environmentId", serde_json::Value::Null),
        (
            "instanceId",
            serde_json::json!("d9c81ebd578545a39206a2aa497d68fc"),
        ),
        ("startedAt", serde_json::json!("yesterday")),
        ("authToken", serde_json::Value::Null),
    ] {
        let sandbox = Sandbox::new();
        let mut record = value(1);
        record[key] = field;
        assert!(matches!(
            LocalDaemon::discover(&sandbox.record(&record)),
            Err(Error::RecordFormat)
        ));
    }
}

#[test]
#[ignore = "requires an explicitly owned daemon fixture; use native-discovery-smoke.mjs"]
fn reads_explicit_owned_daemon_catalog() {
    let path =
        std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").expect("explicit owned record required");
    let daemon = std::sync::Arc::new(LocalDaemon::discover(Path::new(&path)).unwrap());
    let servers = daemon.list_servers().unwrap();
    assert!(
        servers
            .iter()
            .any(|entry| matches!(entry, ServerRegistration::Online { .. }))
    );
    let selected = servers
        .iter()
        .find_map(|entry| match entry {
            ServerRegistration::Online { scope, .. } => Some(scope),
            _ => None,
        })
        .unwrap();
    let client = daemon.select_server(selected).unwrap();
    assert!(!client.sessions().unwrap().is_empty());
    daemon.verify_current().unwrap();
}

#[test]
fn oversized_identity_hits_the_body_limit_before_json_parsing() {
    let (port, worker) = peer(|| {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            LIMIT + 1,
            " ".repeat(LIMIT as usize + 1)
        )
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    assert!(matches!(
        LocalDaemon::discover(&path),
        Err(Error::Network(ureq::Error::BodyExceedsLimit(LIMIT)))
    ));
    worker.join().unwrap();
}

fn server_scope() -> crate::tmux_handoff::ServerScope {
    crate::tmux_handoff::ServerScope {
        server_id: "tmux-server.0123456789abcdef0123456789abcdef".into(),
        generation: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into(),
    }
}
fn registrations() -> serde_json::Value {
    let scope = server_scope();
    serde_json::json!({"version":1,"servers":[{"state":"online","label":"fixture","serverId":scope.server_id,"generation":scope.generation}]})
}
#[test]
fn retired_selection_cannot_accept_delayed_sessions_or_send_new_requests() {
    use std::sync::{Arc, mpsc};
    let (arrived, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let (port, worker) = peer_many(3, move |index| match index {
        0 => response(&identity()),
        1 => response(&registrations()),
        _ => {
            arrived.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            let scope = server_scope();
            response(
                &serde_json::json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"sessions":[]}),
            )
        }
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let daemon = Arc::new(LocalDaemon::discover(&path).unwrap());
    let client = Arc::new(daemon.select_server(&server_scope()).unwrap());
    let other = Arc::clone(&client);
    let read = thread::spawn(move || other.sessions());
    arrival.recv_timeout(Duration::from_secs(5)).unwrap();
    client.retire();
    release.send(()).unwrap();
    assert!(matches!(read.join().unwrap(), Err(Error::Retired)));
    assert!(matches!(client.sessions(), Err(Error::Retired)));
    assert!(matches!(
        client.create_session(uuid::Uuid::new_v4(), "not sent"),
        Err(Error::Retired)
    ));
    let requests = worker.join().unwrap();
    assert_eq!(requests.matches("GET ").count(), 3);
}

#[test]
#[ignore = "creates a session in an explicitly owned scratch daemon only"]
fn creates_session_in_explicit_owned_fixture() {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_ALLOW_MUTATION").unwrap(),
        "owned-scratch-fleet"
    );
    let path = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let daemon = std::sync::Arc::new(LocalDaemon::discover(Path::new(&path)).unwrap());
    let scope = daemon
        .list_servers()
        .unwrap()
        .into_iter()
        .find_map(|entry| match entry {
            ServerRegistration::Online { scope, .. } => Some(scope),
            _ => None,
        })
        .unwrap();
    let mut worker = CatalogWorker::spawn(path.into()).unwrap();
    worker
        .submit(CatalogAction::Create {
            scope: scope.clone(),
            operation_id: uuid::Uuid::new_v4(),
            display_name: "Rust owner fixture".into(),
        })
        .unwrap();
    let CatalogResult::Created(receipt) = worker_tests::await_result(&mut worker).unwrap() else {
        panic!("expected created receipt");
    };
    assert_eq!(receipt.outcome, CreateOutcome::Created);
    worker
        .submit(CatalogAction::Sessions {
            scope: scope.clone(),
        })
        .unwrap();
    let CatalogResult::Sessions(sessions) = worker_tests::await_result(&mut worker).unwrap() else {
        panic!("expected sessions");
    };
    assert!(sessions.iter().any(|session| Some(&session.live_session_id)
        == receipt.live_session_id.as_ref()
        && session.workspace_name.as_ref() == Some(&receipt.workspace_name)));
    let live_session_id = receipt.live_session_id.unwrap();
    worker
        .submit(CatalogAction::Open {
            scope: scope.clone(),
            live_session_id: live_session_id.clone(),
        })
        .unwrap();
    let CatalogResult::Opened {
        workspace_name,
        panes,
    } = worker_tests::await_result(&mut worker).unwrap()
    else {
        panic!("expected opened session");
    };
    assert_eq!(workspace_name, receipt.workspace_name);
    assert!(!panes.is_empty());
    worker
        .submit(CatalogAction::ObserveAgents {
            expected_catalog: None,
            scope: scope.clone(),
            live_session_id: live_session_id.clone(),
            workspace_name: workspace_name.clone(),
        })
        .unwrap();
    let CatalogResult::AgentObservation(observation) =
        worker_tests::await_result(&mut worker).unwrap()
    else {
        panic!("expected agent observation")
    };
    assert_eq!(observation.scope, scope);
    assert_eq!(observation.live_session_id, live_session_id);
    assert_eq!(observation.workspace_name, workspace_name);
    assert!(observation.agents.is_empty());
    #[cfg(unix)]
    let mut observation_fleet = FleetRegistry::new(daemon.path.clone());
    #[cfg(unix)]
    let observation_source = {
        observation_fleet
            .reconcile(
                SavedMachineRegistry {
                    version: 1,
                    machines: vec![],
                },
                "selected-remote",
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let event = loop {
            if let Some(event) = observation_fleet.poll().unwrap().pop() {
                break event;
            }
            assert!(Instant::now() < deadline, "fleet catalog did not settle");
            thread::sleep(Duration::from_millis(5));
        };
        let identity = event.result.unwrap().identity;
        assert_eq!(
            identity,
            owner::Owner::Local(daemon.clone()).catalog_identity()
        );
        observation_fleet
            .agent_observation_source("local", event.incarnation, &identity)
            .unwrap()
    };
    #[cfg(not(unix))]
    let observation_source = CatalogSource::Local(daemon.path.clone());
    let mut observations = AgentObservationPool::default();
    let epoch = observations
        .replace(vec![AgentObservationRequest {
            key: "owned-session".into(),
            catalog_identity: owner::Owner::Local(daemon.clone()).catalog_identity(),
            source: observation_source,
            scope: scope.clone(),
            live_session_id: live_session_id.clone(),
            workspace_name: workspace_name.clone(),
        }])
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut observed = 0;
    while observations.busy() {
        for event in observations.poll() {
            assert_eq!(event.epoch, epoch);
            assert_eq!(event.key, "owned-session");
            assert_eq!(event.result.unwrap(), observation);
            observed += 1;
        }
        assert!(
            Instant::now() < deadline,
            "agent observation pool did not retire"
        );
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(observed, 1);
    #[cfg(unix)]
    {
        let incarnation = observation_fleet.routes().next().unwrap().2;
        let identity = owner::Owner::Local(daemon.clone()).catalog_identity();
        assert!(
            observation_fleet
                .agent_observation_source("local", incarnation, &identity)
                .is_some()
        );
        observation_fleet.disconnect("local", incarnation).unwrap();
        assert!(
            observation_fleet
                .agent_observation_source("local", incarnation, &identity)
                .is_none()
        );
        observation_fleet.invalidate().unwrap();
    }

    worker
        .submit(CatalogAction::EditorContext {
            scope: scope.clone(),
            target: EditorTarget {
                generation: scope.generation.clone(),
                workspace_name: workspace_name.clone(),
                live_session_id: live_session_id.clone(),
                semantic_pane_id: panes[0].clone(),
            },
        })
        .unwrap();
    let CatalogResult::EditorContext(context) = worker_tests::await_result(&mut worker).unwrap()
    else {
        panic!("expected editor context");
    };
    assert!(Path::new(context.directory()).is_absolute());
    assert!(Path::new(context.directory()).is_dir());
    worker
        .submit(CatalogAction::CreatePane {
            scope: scope.clone(),
            operation_id: uuid::Uuid::new_v4(),
            creation: PaneCreation {
                workspace_name: workspace_name.clone(),
                live_session_id: live_session_id.clone(),
                source_pane: panes[0].clone(),
                kind: NewPane::Terminal,
            },
        })
        .unwrap();
    let CatalogResult::PaneCreated(created) = worker_tests::await_result(&mut worker).unwrap()
    else {
        panic!("expected created pane");
    };
    assert_eq!(created.outcome, PaneCreateOutcome::Created);
    assert_eq!(created.resource.kind, PaneKind::Terminal);
    let selected = daemon.select_server(&scope).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let current_panes = selected
            .workspace_panes(&live_session_id, &workspace_name)
            .unwrap();
        if current_panes.contains(&created.resource.semantic_pane_id) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "created pane {} missing from fresh inventory {:?}",
            created.resource.semantic_pane_id,
            current_panes
        );
        thread::sleep(Duration::from_millis(50));
    }
    worker
        .submit(CatalogAction::Issue {
            scope,
            selection: TerminalSelection {
                workspace_name,
                live_session_id,
                selected_pane: panes[0].clone(),
                visible_panes: panes,
                mode: crate::tmux_stream::ViewerMode::ReadOnly,
            },
        })
        .unwrap();
    let CatalogResult::Issued(handoff) = worker_tests::await_result(&mut worker).unwrap() else {
        panic!("expected terminal capability");
    };
    assert!(handoff.local_images.is_some());
    let (options, _, _) = handoff.into_connection();
    let stream = crate::tmux_stream::PaneStream::spawn(options).unwrap();
    assert!(matches!(
        stream.events().recv_timeout(Duration::from_secs(5)),
        Ok(crate::tmux_stream::Event::Ready(_))
    ));
    drop(stream);
    drop(worker);
}

#[test]
fn creation_is_sent_once_and_bad_receipt_stays_uncertain() {
    let operation = uuid::Uuid::new_v4();
    let (port, worker) = peer_many(3, move |index| match index {
        0 => response(&identity()),
        1 => response(&registrations()),
        _ => response(&serde_json::json!({
            "operationId":operation.to_string(),"daemonInstanceId":uuid::Uuid::new_v4().to_string(),"outcome":"created",
            "fleetSessionId":"session.0123456789abcdef","workspaceName":"fixture","displayName":"fixture"
        })),
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let daemon = std::sync::Arc::new(LocalDaemon::discover(&path).unwrap());
    let client = daemon.select_server(&server_scope()).unwrap();
    assert!(
        matches!(client.create_session(operation," fixture "),Err(Error::ActionUncertain {operation_id,source}) if operation_id==operation && matches!(*source,Error::ServerChanged))
    );
    let requests = worker.join().unwrap();
    assert_eq!(requests.matches("POST ").count(), 1);
    let (_, post) = requests.split_once("POST ").unwrap();
    let (_, body) = post.split_once("\r\n\r\n").unwrap();
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["operationId"], operation.to_string());
    assert_eq!(body["expectedDaemonInstanceId"], server_scope().generation);
    assert_eq!(body["intent"]["displayName"], "fixture");
    assert_eq!(body["intent"]["includeLiveSessionId"], true);
}

#[path = "worker_tests.rs"]
mod worker_tests;

#[test]
fn retired_editor_read_does_not_accept_the_directory_or_reverify_owner() {
    use std::sync::{Arc, mpsc};
    let (arrived, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let (port, worker) = peer_many(4, move |index| match index {
        0 | 2 => response(&identity()),
        1 => response(&registrations()),
        _ => {
            arrived.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            response(&serde_json::json!({"version":1}))
        }
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let daemon = Arc::new(LocalDaemon::discover(&path).unwrap());
    let client = Arc::new(daemon.select_server(&server_scope()).unwrap());
    let other = Arc::clone(&client);
    let read = thread::spawn(move || {
        other.editor_context(&EditorTarget {
            generation: server_scope().generation,
            workspace_name: "fixture".into(),
            live_session_id: format!("live-session.{}", "b".repeat(20)),
            semantic_pane_id: "pane.fixture".into(),
        })
    });
    arrival.recv_timeout(Duration::from_secs(5)).unwrap();
    client.retire();
    release.send(()).unwrap();
    assert!(matches!(read.join().unwrap(), Err(Error::Retired)));
    let requests = worker.join().unwrap();
    assert_eq!(requests.matches("POST ").count(), 1);
    assert_eq!(requests.matches("GET ").count(), 3);
    assert!(requests.contains("/pane-editor-context"));
}

#[test]
fn pane_creation_bad_response_retains_operation_without_replay() {
    let operation = uuid::Uuid::new_v4();
    let (port, worker) = peer_many(3, move |index| match index {
        0 => response(&identity()),
        1 => response(&registrations()),
        _ => response(&serde_json::json!({"invalid":"receipt"})),
    });
    let sandbox = Sandbox::new();
    let path = sandbox.record(&value(port));
    let daemon = std::sync::Arc::new(LocalDaemon::discover(&path).unwrap());
    let client = daemon.select_server(&server_scope()).unwrap();
    let creation = PaneCreation {
        workspace_name: "fixture".into(),
        live_session_id: format!("live-session.{}", "a".repeat(20)),
        source_pane: "pane.source".into(),
        kind: NewPane::Terminal,
    };
    assert!(
        matches!(client.create_pane(operation, &creation), Err(Error::ActionUncertain { operation_id, source }) if operation_id == operation && matches!(*source, Error::ResourceFormat))
    );
    client.retire();
    assert!(matches!(
        client.create_pane(uuid::Uuid::new_v4(), &creation),
        Err(Error::Retired)
    ));
    let requests = worker.join().unwrap();
    assert_eq!(requests.matches("POST ").count(), 1);
    let (_, post) = requests.split_once("POST ").unwrap();
    assert!(post.starts_with(&format!(
        "/api/v1/tmux-servers/{}/{}/panes/create?liveSessionId={} ",
        server_scope().server_id,
        server_scope().generation,
        creation.live_session_id
    )));
    let (_, body) = post.split_once("\r\n\r\n").unwrap();
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["operationId"], operation.to_string());
    assert_eq!(body["intent"]["placement"]["kind"], "window");
}

#[path = "fleet_catalog_tests.rs"]
mod fleet_catalog_tests;

#[path = "fleet_pool_tests.rs"]
mod fleet_pool_tests;

#[cfg(unix)]
#[path = "fleet_recovery_tests.rs"]
mod fleet_recovery_tests;

#[path = "agent_observation_socket_tests.rs"]
mod agent_observation_socket_tests;

#[path = "surface_source_socket_tests.rs"]
mod surface_source_socket_tests;
