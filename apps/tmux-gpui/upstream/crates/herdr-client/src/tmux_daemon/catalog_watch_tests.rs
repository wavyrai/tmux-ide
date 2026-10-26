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
        assert_eq!(subscribe["interests"].as_array().unwrap().len(), 1);
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
fn healthy_idle_watch_requests_bounded_fallback_without_reconnecting() {
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
