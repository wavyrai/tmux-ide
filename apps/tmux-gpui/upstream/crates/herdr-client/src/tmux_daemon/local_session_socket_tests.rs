use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::OpenOptionsExt,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
fn exercise(online_before: bool, lose_response: bool) {
    let sandbox = super::super::super::tests::Sandbox::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let path = sandbox.0.join("daemon.json");
    let generation = Uuid::new_v4().to_string();
    let record = serde_json::json!({"pid":123,"port":listener.local_addr().unwrap().port(),"protocolVersion":4,"productVersion":"2.9.12","instanceId":generation,"startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"private-fixture-secret"});
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap()
        .write_all(record.to_string().as_bytes())
        .unwrap();
    let mut identity = record.clone();
    identity["ok"] = true.into();
    identity.as_object_mut().unwrap().remove("authToken");
    let posts = Arc::new(Mutex::new(Vec::new()));
    let requests = posts.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let online = Arc::new(AtomicBool::new(false));
    let server_online = online.clone();
    let owner_id = generation.clone();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(12);
        while !stopped.load(Ordering::Acquire) && Instant::now() < deadline {
            let mut socket = match listener.accept() {
                Ok((socket, _)) => socket,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => panic!("{e}"),
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                let mut b = [0];
                socket.read_exact(&mut b).unwrap();
                headers.push(b[0]);
                assert!(headers.len() < 8192);
            }
            let headers = String::from_utf8(headers).unwrap();
            let lower = headers.to_lowercase();
            let body = if headers.starts_with("GET /identity ") {
                assert!(!lower.contains("authorization:"));
                identity.to_string()
            } else if headers.starts_with("GET /api/v1/tmux-servers ") {
                assert!(headers.contains("Bearer private-fixture-secret"));
                serde_json::json!({"version":1,"servers":if server_online.load(Ordering::Acquire){vec![serde_json::json!({"state":"online","serverId":format!("tmux-server.{}","a".repeat(32)),"label":"fixture","generation":owner_id})]}else{vec![]}}).to_string()
            } else {
                assert!(headers.starts_with("POST /api/v2/action/workspace.session.create "));
                assert!(headers.contains("Bearer private-fixture-secret"));
                let length = lower
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .map(|n| n.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                assert!(length < 4096);
                let mut bytes = vec![0; length];
                socket.read_exact(&mut bytes).unwrap();
                let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(value["expectedDaemonInstanceId"], owner_id);
                assert_eq!(value["includeLiveSessionId"], true);
                assert_eq!(value["displayName"], "Fixture shell");
                let op = lower
                    .lines()
                    .find_map(|l| l.strip_prefix("x-tmux-ide-operation-id:").map(str::trim))
                    .unwrap()
                    .to_string();
                requests.lock().unwrap().push(op.clone());
                if lose_response {
                    continue;
                }
                serde_json::json!({"ok":true,"result":{"operationId":op,"daemonInstanceId":owner_id,"outcome":"created","fleetSessionId":"session.0123456789abcdef","workspaceName":"fixture","displayName":"Fixture shell","liveSessionId":"live-session.0123456789abcdef0123"}}).to_string()
            };
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    });
    let daemon = LocalDaemon::discover(&path).unwrap();
    let cancelled = AtomicBool::new(false);
    let proof = daemon.prove_local_session_create(&cancelled).unwrap();
    let duplicate = proof.clone();
    online.store(online_before, Ordering::Release);
    let operation = Uuid::new_v4();
    let result = daemon.create_local_session(&proof, operation, "Fixture shell", &cancelled);
    if online_before {
        assert!(matches!(result, Err(Error::ServerChanged)));
    } else if lose_response {
        assert!(
            matches!(result,Err(Error::ActionUncertain{operation_id,..}) if operation_id==operation)
        );
    } else {
        assert_eq!(result.unwrap().operation_id, operation.to_string());
        daemon.verify_local_session_owner(&proof).unwrap();
    }
    assert!(matches!(
        daemon.create_local_session(&duplicate, Uuid::new_v4(), "Fixture shell", &cancelled),
        Err(Error::Retired)
    ));
    stop.store(true, Ordering::Release);
    server.join().unwrap();
    assert_eq!(posts.lock().unwrap().len(), usize::from(!online_before));
}
#[test]
fn one_post_and_validated_receipt() {
    exercise(false, false);
}
#[test]
fn server_appearing_after_offer_prevents_post() {
    exercise(true, false);
}
#[test]
fn lost_response_is_uncertain_and_cannot_be_replayed() {
    exercise(false, true);
}
