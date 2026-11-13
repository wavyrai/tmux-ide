#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::OpenOptionsExt,
};
fn fixture() -> (
    super::super::tests::Sandbox,
    TcpListener,
    CatalogSource,
    Value,
    CatalogIdentity,
) {
    let sandbox = super::super::tests::Sandbox::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let path = sandbox.0.join("daemon.json");
    let record = json!({"pid":123,"port":listener.local_addr().unwrap().port(),"protocolVersion":4,
        "productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc",
        "startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"fixture-private"});
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap()
        .write_all(record.to_string().as_bytes())
        .unwrap();
    let identity = json!({"pid":123,"ok":true,"protocolVersion":4,"productVersion":"2.9.12",
        "instanceId":record["instanceId"],"startedAt":record["startedAt"]});
    let expected = CatalogIdentity {
        instance_id: record["instanceId"].as_str().unwrap().into(),
        environment_id: None,
    };
    (
        sandbox,
        listener,
        CatalogSource::Local(path),
        identity,
        expected,
    )
}
fn request(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut socket = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("{error}"),
        }
    };
    socket.set_nonblocking(false).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        socket.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 8192);
    }
    let text = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
    assert!(text.starts_with("get /identity "));
    assert!(!text.contains("authorization"));
    socket
}
fn response(socket: &mut TcpStream, body: &Value, close: bool) {
    let body = body.to_string();
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n{body}",
        body.len(),
        if close { "close" } else { "keep-alive" }
    )
    .unwrap();
}
fn proofs(listener: &TcpListener, identity: &Value) -> TcpStream {
    for _ in 0..2 {
        response(&mut request(listener), identity, true);
    }
    request(listener)
}
// tungstenite requires its fixed HTTP ErrorResponse callback type.
#[allow(clippy::result_large_err)]
fn upgrade(socket: TcpStream) -> tungstenite::WebSocket<TcpStream> {
    tungstenite::accept_hdr(
        socket,
        |request: &tungstenite::handshake::server::Request, response| {
            assert_eq!(request.uri().to_string(), "/ws/events?mode=semantic");
            assert_eq!(
                request.headers().get("authorization").unwrap(),
                "Bearer fixture-private"
            );
            Ok(response)
        },
    )
    .unwrap()
}
fn until(worker: &CatalogWatchWorker) -> Result<(), CatalogWatchError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(result) = worker.poll().unwrap() {
            return result;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn same_socket_proof_precedes_credentials_and_notifications_coalesce() {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let (done, received) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        response(&mut socket, &identity, false);
        let mut socket = upgrade(socket);
        let mut daemon = identity;
        daemon.as_object_mut().unwrap().remove("pid");
        daemon.as_object_mut().unwrap().remove("ok");
        socket
            .send(Message::Text(
                json!({"type":"hello","daemon":daemon,"sessions":[],"eventSequence":0})
                    .to_string()
                    .into(),
            ))
            .unwrap();
        let subscribe: Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(subscribe["legacyEvents"], false);
        assert_eq!(subscribe["interests"].as_array().unwrap().len(), 2);
        socket.send(Message::Text(json!({"type":"resource.interests-ack","interestRevision":1,"sequence":0,"unavailableInterests":[]}).to_string().into())).unwrap();
        for sequence in 1..=20 {
            socket.send(Message::Text(json!({"type":"resource.changed","sequence":sequence,"resource":"workspace-catalog","workspaceName":null,"revision":sequence,"causeOperationId":null}).to_string().into())).unwrap();
        }
        socket.send(Message::Ping(vec![1].into())).unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Pong(_)));
        done.send(()).unwrap();
        assert!(socket.read().is_err());
    });
    let worker = CatalogWatchWorker::spawn(source, expected, || {}).unwrap();
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(worker.poll().unwrap().unwrap().is_ok());
    assert!(worker.poll().unwrap().is_none());
    let start = Instant::now();
    worker.shutdown().unwrap();
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(worker.poll().unwrap().is_none());
    server.join().unwrap();
}
#[test]
fn changed_identity_on_upgrade_socket_receives_no_credential() {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        let mut foreign = identity;
        foreign["instanceId"] = json!(uuid::Uuid::new_v4().to_string());
        response(&mut socket, &foreign, false);
        let mut byte = [0];
        assert_eq!(socket.read(&mut byte).unwrap(), 0);
    });
    let worker = CatalogWatchWorker::spawn(source, expected, || {}).unwrap();
    assert!(matches!(
        until(&worker),
        Err(CatalogWatchError::Identity(_))
    ));
    assert!(worker.poll().unwrap().is_none());
    worker.shutdown().unwrap();
    server.join().unwrap();
}
#[test]
fn cancellation_interrupts_idle_socket_before_hello() {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let (ready, received) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        response(&mut socket, &identity, false);
        let mut socket = upgrade(socket);
        ready.send(()).unwrap();
        assert!(socket.read().is_err());
    });
    let worker = CatalogWatchWorker::spawn(source, expected, || {}).unwrap();
    received.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.shutdown().unwrap();
    assert!(worker.poll().unwrap().is_none());
    server.join().unwrap();
}

#[test]
fn without_fleet_push_an_idle_watch_requests_the_bounded_fallback() {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        response(&mut socket, &identity, false);
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut socket = upgrade(socket);
        let mut daemon = identity;
        daemon.as_object_mut().unwrap().remove("pid");
        daemon.as_object_mut().unwrap().remove("ok");
        socket
            .send(Message::Text(
                json!({"type":"hello","daemon":daemon,"sessions":[],"eventSequence":0})
                    .to_string()
                    .into(),
            ))
            .unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Text(_)));
        socket.send(Message::Text(json!({"type":"resource.interests-ack","interestRevision":1,"sequence":0,"unavailableInterests":[{"resource":"fleet-catalog","workspaceName":null}]}).to_string().into())).unwrap();
        assert!(socket.read().is_err());
    });
    let worker = CatalogWatchWorker::spawn(source, expected, || {}).unwrap();
    until(&worker).unwrap();
    let start = Instant::now();
    let deadline = start + Duration::from_secs(8);
    loop {
        if let Some(result) = worker.poll().unwrap() {
            result.unwrap();
            assert!(start.elapsed() >= Duration::from_secs(4));
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    worker.shutdown().unwrap();
    server.join().unwrap();
}

#[test]
fn with_fleet_push_an_idle_watch_never_polls() {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        response(&mut socket, &identity, false);
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut socket = upgrade(socket);
        let mut daemon = identity;
        daemon.as_object_mut().unwrap().remove("pid");
        daemon.as_object_mut().unwrap().remove("ok");
        socket
            .send(Message::Text(
                json!({"type":"hello","daemon":daemon,"sessions":[],"eventSequence":0})
                    .to_string()
                    .into(),
            ))
            .unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Text(_)));
        socket.send(Message::Text(json!({"type":"resource.interests-ack","interestRevision":1,"sequence":0,"unavailableInterests":[]}).to_string().into())).unwrap();
        assert!(socket.read().is_err());
    });
    let worker = CatalogWatchWorker::spawn(source, expected, || {}).unwrap();
    until(&worker).unwrap();
    // The fallback fired after 5 s; with push nothing arrives without an event.
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(7) {
        assert!(
            worker.poll().unwrap().is_none(),
            "an idle pushed watch refreshed"
        );
        thread::sleep(Duration::from_millis(10));
    }
    worker.shutdown().unwrap();
    server.join().unwrap();
}

fn daemon_hello(identity: &Value, sequence: u64) -> Message {
    let mut daemon = identity.clone();
    daemon.as_object_mut().unwrap().remove("pid");
    daemon.as_object_mut().unwrap().remove("ok");
    Message::Text(
        json!({"type":"hello","daemon":daemon,"sessions":[],"eventSequence":sequence})
            .to_string()
            .into(),
    )
}
fn ack(sequence: u64) -> Message {
    Message::Text(json!({"type":"resource.interests-ack","interestRevision":1,"sequence":sequence,"unavailableInterests":[]}).to_string().into())
}
fn catalog_change(sequence: u64) -> Message {
    Message::Text(json!({"type":"resource.changed","sequence":sequence,"resource":"fleet-catalog","workspaceName":null,"revision":sequence,"causeOperationId":null}).to_string().into())
}
fn wait(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
}

/// A change that arrives just before the lane drops is reported before the
/// drop, never overwritten by it: the caller still reads it (review of #362).
#[test]
fn a_change_just_before_a_drop_is_reported_first() {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let (go, start) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        response(&mut socket, &identity, false);
        let mut socket = upgrade(socket);
        socket.send(daemon_hello(&identity, 0)).unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Text(_)));
        socket.send(ack(0)).unwrap();
        start.recv().unwrap();
        socket.send(catalog_change(1)).unwrap();
        socket.get_mut().shutdown(Shutdown::Both).unwrap();
    });
    let worker = CatalogWatchWorker::spawn(source, expected, || {}).unwrap();
    until(&worker).unwrap(); // the barrier's own read
    go.send(()).unwrap();
    wait(|| !worker.live() && worker.sequence() == 1);
    thread::sleep(Duration::from_millis(50));
    assert!(
        matches!(worker.poll().unwrap(), Some(Ok(()))),
        "the change first"
    );
    assert!(
        matches!(worker.poll().unwrap(), Some(Err(_))),
        "then the drop"
    );
    server.join().unwrap();
}

/// The cursor for a read comes only from a live lane.
#[test]
fn a_read_start_is_known_only_on_a_live_lane() {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let (go, start) = mpsc::sync_channel(1);
    let (more, next) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        response(&mut socket, &identity, false);
        let mut socket = upgrade(socket);
        start.recv().unwrap();
        socket.send(daemon_hello(&identity, 7)).unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Text(_)));
        socket.send(ack(7)).unwrap();
        next.recv().unwrap();
        socket.send(catalog_change(8)).unwrap();
        assert!(socket.read().is_err());
    });
    let worker = CatalogWatchWorker::spawn(source, expected, || {}).unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(worker.read_start(), None, "before the barrier");
    go.send(()).unwrap();
    until(&worker).unwrap();
    assert_eq!(worker.read_start(), Some(7));
    more.send(()).unwrap();
    until(&worker).unwrap();
    assert_eq!(worker.read_start(), Some(8));
    worker.shutdown().unwrap();
    server.join().unwrap();
}

/// A resumed lane subscribes after its cursor; with nothing changed it is
/// live and asks for no read.
#[test]
fn a_resumed_lane_subscribes_after_its_cursor_and_reads_nothing() {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        response(&mut socket, &identity, false);
        let mut socket = upgrade(socket);
        socket.send(daemon_hello(&identity, 12)).unwrap();
        let subscribe: Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(subscribe["afterSequence"], 9);
        socket.send(ack(12)).unwrap();
        assert!(socket.read().is_err());
    });
    let worker = CatalogWatchWorker::resume(source, expected, Some(9), || {}).unwrap();
    wait(|| worker.live());
    thread::sleep(Duration::from_millis(50));
    assert!(worker.poll().unwrap().is_none(), "nothing changed: no read");
    assert_eq!(worker.read_start(), Some(12));
    worker.shutdown().unwrap();
    server.join().unwrap();
}

/// A live lane on a daemon that advertised `heartbeat` (or not) and then
/// sends nothing and reads nothing. Returns how the lane ended within `watch`.
fn silent_after_ready(
    heartbeat: Option<&'static str>,
    watch: Duration,
) -> Option<(Duration, CatalogWatchError)> {
    let (_sandbox, listener, source, identity, expected) = fixture();
    let server = thread::spawn(move || {
        let mut socket = proofs(&listener, &identity);
        response(&mut socket, &identity, false);
        socket
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        #[allow(clippy::result_large_err)]
        let mut socket = tungstenite::accept_hdr(
            socket,
            |_: &tungstenite::handshake::server::Request,
             mut response: tungstenite::handshake::server::Response| {
                if let Some(heartbeat) = heartbeat {
                    response
                        .headers_mut()
                        .insert("x-tmux-ide-heartbeat", heartbeat.parse().unwrap());
                }
                Ok(response)
            },
        )
        .unwrap();
        socket.send(daemon_hello(&identity, 0)).unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Text(_)));
        socket.send(ack(0)).unwrap();
        // Half-open: the peer neither sends nor reads until the client leaves.
        let mut raw = socket.get_ref().try_clone().unwrap();
        drop(socket);
        thread::sleep(Duration::from_millis(50));
        let _ = raw.read(&mut [0; 1]);
    });
    let worker = CatalogWatchWorker::spawn(source, expected, || {}).unwrap();
    wait(|| worker.live());
    let started = Instant::now();
    let mut ended = None;
    while started.elapsed() < watch {
        if let Some(Err(error)) = worker.poll().unwrap() {
            ended = Some((started.elapsed(), error));
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    worker.shutdown().unwrap();
    server.join().unwrap();
    ended
}

/// PM, 12 Nov 2026: with the daemon's heartbeat header, silence past its
/// limit (250 ms x 2, plus one interval) ends the events lane, so it is
/// connected again. The client's own 15 s ping would not have noticed for 45 s.
#[test]
fn a_silent_daemon_that_advertised_a_heartbeat_ends_the_events_lane() {
    let (after, error) = silent_after_ready(
        Some("interval-ms=250, missed-limit=2"),
        Duration::from_secs(4),
    )
    .unwrap();
    assert!(matches!(error, CatalogWatchError::Timeout), "{error:?}");
    assert!(
        after >= Duration::from_millis(600) && after < Duration::from_millis(2500),
        "ended after {after:?}"
    );
}

/// A 2.9.22 daemon sends no header: the lane keeps its own 45 s limit.
#[test]
fn a_silent_daemon_without_the_header_keeps_the_events_lane() {
    for header in [None, Some("interval-ms=250")] {
        let ended = silent_after_ready(header, Duration::from_millis(1500));
        assert!(ended.is_none(), "{header:?}: {:?}", ended.map(|e| e.0));
    }
}
