#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_ssh::{RemoteDescriptor, RemoteTransport};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Mutex, mpsc},
    thread,
    time::Duration,
};
fn identity() -> serde_json::Value {
    serde_json::json!({"ok":true,"pid":123,"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z"})
}
fn descriptor() -> RemoteDescriptor {
    let mut value = identity();
    value.as_object_mut().unwrap().remove("ok");
    value["port"] = 4111.into();
    value["bindHostname"] = "127.0.0.1".into();
    value["authToken"] = "fixture".into();
    RemoteDescriptor::parse(
        &serde_json::to_vec(&serde_json::json!({"version":1,"daemon":value})).unwrap(),
        None,
    )
    .unwrap()
}
fn request(stream: &mut TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 8192);
    }
}
fn reply(stream: &mut TcpStream, body: serde_json::Value) {
    let body = serde_json::to_vec(&body).unwrap();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.write_all(&body).unwrap();
}
fn fixture() -> RemoteTransport {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        request(&mut stream);
        reply(&mut stream, identity());
    });
    let route = RemoteTransport::fixture(port, descriptor()).unwrap();
    server.join().unwrap();
    route
}
fn route(owner: &Owner) -> &Arc<RemoteTransport> {
    match owner {
        Owner::Remote(route) => route,
        _ => panic!("not remote"),
    }
}
fn shutdown(owner: Owner) {
    let Owner::Remote(route) = owner else {
        panic!("not remote")
    };
    let Ok(route) = Arc::try_unwrap(route) else {
        panic!("route retained")
    };
    route.shutdown_fixture().unwrap();
}
#[test]
fn stale_worker_reset_cannot_retire_replacement_generation() {
    let source = CatalogSource::Remote(Arc::new(RemoteSource {
        target: crate::tmux_ssh::SshTarget::parse("fixture.invalid").unwrap(),
        expected_environment: None,
        route: Mutex::new(Some(fixture())),
        opening: Mutex::new(None),
        stopped: AtomicBool::new(false),
    }));
    let first = source.discover(&Arc::new(AtomicBool::new(false))).unwrap();
    let second = source.discover(&Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(route(&first).generation(), route(&second).generation());
    source.reset(Some(&first)).unwrap();
    assert!(route(&second).capability_route().is_err());
    let CatalogSource::Remote(shared) = &source else {
        panic!("not remote")
    };
    *shared.route.lock().unwrap() = Some(fixture());
    source.reset(Some(&second)).unwrap();
    let replacement = source.discover(&Arc::new(AtomicBool::new(false))).unwrap();
    assert_ne!(route(&first).generation(), route(&replacement).generation());
    assert!(route(&replacement).capability_route().is_ok());
    drop(second);
    shutdown(first);
    drop(source);
    shutdown(replacement);
}
#[test]
fn slow_lane_does_not_block_foreground_on_shared_tunnel() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (blocked_tx, blocked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut slow, _) = listener.accept().unwrap();
        request(&mut slow);
        reply(&mut slow, identity());
        let slow = thread::spawn(move || {
            request(&mut slow);
            blocked_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            reply(&mut slow, serde_json::json!({}));
        });
        let (mut fast, _) = listener.accept().unwrap();
        request(&mut fast);
        reply(&mut fast, identity());
        request(&mut fast);
        reply(&mut fast, serde_json::json!({}));
        slow.join().unwrap();
    });
    let root = RemoteTransport::fixture(port, descriptor()).unwrap();
    let slow = root.fork().unwrap();
    let fast = root.fork().unwrap();
    assert_eq!(slow.generation(), fast.generation());
    let worker = thread::spawn(move || {
        slow.capabilities(&Arc::new(AtomicBool::new(false)))
            .unwrap();
        slow
    });
    blocked_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        fast.capabilities(&Arc::new(AtomicBool::new(false)))
            .unwrap(),
        b"{}"
    );
    release_tx.send(()).unwrap();
    let slow = worker.join().unwrap();
    server.join().unwrap();
    drop(root);
    drop(slow);
    fast.shutdown_fixture().unwrap();
}

#[test]
fn shutdown_retires_all_lanes_and_prevents_rediscovery() {
    let source = CatalogSource::Remote(Arc::new(RemoteSource {
        target: crate::tmux_ssh::SshTarget::parse("fixture.invalid").unwrap(),
        expected_environment: None,
        route: Mutex::new(Some(fixture())),
        opening: Mutex::new(None),
        stopped: AtomicBool::new(false),
    }));
    let cancelled = Arc::new(AtomicBool::new(false));
    let first = source.discover(&cancelled).unwrap();
    let second = source.discover(&cancelled).unwrap();
    source.shutdown().unwrap();
    assert!(route(&first).capability_route().is_err());
    assert!(route(&second).capability_route().is_err());
    assert!(matches!(source.discover(&cancelled), Err(Error::Retired)));
    source.shutdown().unwrap();
    drop(second);
    shutdown(first);
}
#[test]
fn shutdown_cancels_pending_discovery_without_starting_a_connection() {
    let source = CatalogSource::remote(
        crate::tmux_ssh::SshTarget::parse("fixture.invalid").unwrap(),
        None,
    );
    let cancelled = Arc::new(AtomicBool::new(false));
    let CatalogSource::Remote(shared) = &source else {
        panic!("not remote")
    };
    *shared.opening.lock().unwrap() = Some(cancelled.clone());
    source.shutdown().unwrap();
    assert!(cancelled.load(Ordering::Acquire));
    assert!(matches!(
        source.discover(&Arc::new(AtomicBool::new(false))),
        Err(Error::Retired)
    ));
}
