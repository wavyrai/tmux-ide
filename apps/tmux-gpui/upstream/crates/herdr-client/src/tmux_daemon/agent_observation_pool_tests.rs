#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::OpenOptionsExt,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
fn request(key: &str, path: &std::path::Path) -> AgentObservationRequest {
    AgentObservationRequest {
        key: key.into(),
        catalog_identity: super::super::CatalogIdentity {
            instance_id: uuid::Uuid::new_v4().to_string(),
            environment_id: None,
        },
        source: CatalogSource::Local(path.into()),
        scope: ServerScope {
            server_id: format!("tmux-server.{}", "a".repeat(32)),
            generation: uuid::Uuid::new_v4().to_string(),
        },
        live_session_id: format!("live-session.{}", "a".repeat(20)),
        workspace_name: "fixture".into(),
    }
}
#[test]
fn invalid_replacement_preserves_current_batch() {
    let mut pool = AgentObservationPool::default();
    let path = std::path::Path::new("/nonexistent-native-agent-pool/daemon.json");
    let epoch = pool.replace(vec![request("original", path)]).unwrap();
    assert!(
        pool.replace(vec![request("duplicate", path), request("duplicate", path)])
            .is_err()
    );
    assert_eq!(pool.epoch, Some(epoch));
    assert_eq!(pool.queue[0].key, "original");
    assert!(
        pool.replace(
            (0..=MAX_AGENT_OBSERVATION_SESSIONS)
                .map(|i| request(&i.to_string(), path))
                .collect()
        )
        .is_err()
    );
    assert_eq!(pool.queue.len(), 1);
    pool.replace(
        (0..MAX_AGENT_OBSERVATION_SESSIONS)
            .map(|i| request(&i.to_string(), path))
            .collect(),
    )
    .unwrap();
    assert_eq!(pool.queue.len(), MAX_AGENT_OBSERVATION_SESSIONS);
    assert!(pool.active.is_empty());
    pool.cancel();
    assert!(!pool.busy());
}
#[test]
fn failures_are_bounded_correlated_and_retired_without_replay() {
    let mut pool = AgentObservationPool::default();
    let path = std::path::Path::new("/nonexistent-native-agent-pool/daemon.json");
    let old = pool.replace(vec![request("old", path)]).unwrap();
    let epoch = pool
        .replace((0..32).map(|i| request(&i.to_string(), path)).collect())
        .unwrap();
    assert_ne!(old, epoch);
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut keys = BTreeSet::new();
    while pool.busy() {
        for event in pool.poll() {
            assert_eq!(event.epoch, epoch);
            assert!(event.result.is_err());
            assert!(keys.insert(event.key));
        }
        assert!(pool.active.len() + pool.retiring.len() <= 4);
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(keys.len(), 32);
    assert!(!keys.contains("old"));
    assert!(pool.poll().is_empty());
}
#[test]
fn repeated_refresh_cannot_exceed_four_unfinished_reads() {
    let sandbox = super::super::tests::Sandbox::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let path = sandbox.0.join("daemon.json");
    let record = serde_json::json!({"pid":123,"port":listener.local_addr().unwrap().port(),"protocolVersion":4,"productVersion":"2.9.12","instanceId":uuid::Uuid::new_v4().to_string(),"startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"private-fixture-secret"});
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap()
        .write_all(record.to_string().as_bytes())
        .unwrap();
    let mut identity = record;
    identity["ok"] = true.into();
    identity.as_object_mut().unwrap().remove("authToken");
    let (arrived, waiting) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut sockets = Vec::new();
        while sockets.len() < 4 {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    socket.set_nonblocking(false).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    while !bytes.ends_with(b"\r\n\r\n") {
                        let mut b = [0];
                        socket.read_exact(&mut b).unwrap();
                        bytes.push(b[0]);
                        assert!(bytes.len() < 8192);
                    }
                    let headers = String::from_utf8(bytes).unwrap();
                    assert!(headers.starts_with("GET /identity "));
                    assert!(!headers.to_lowercase().contains("authorization:"));
                    sockets.push(socket);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2))
                }
                Err(e) => panic!("{e}"),
            }
            assert!(Instant::now() < deadline);
        }
        arrived.send(()).unwrap();
        held.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
        let body = identity.to_string();
        for mut socket in sockets {
            let _ = write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }
    });
    let mut pool = AgentObservationPool::default();
    pool.replace((0..32).map(|i| request(&i.to_string(), &path)).collect())
        .unwrap();
    assert!(pool.poll().is_empty());
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    for _ in 0..100 {
        pool.replace((0..32).map(|i| request(&i.to_string(), &path)).collect())
            .unwrap();
        assert!(pool.poll().is_empty());
        assert!(pool.active.is_empty());
        assert_eq!(pool.retiring.len(), 4);
    }
    pool.cancel();
    assert!(pool.busy());
    release.send(()).unwrap();
    server.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while pool.busy() {
        assert!(pool.poll().is_empty());
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
}
