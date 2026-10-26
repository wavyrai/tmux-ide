#![allow(clippy::unwrap_used)]
use super::*;
use std::{net::TcpListener, os::unix::fs::OpenOptionsExt, sync::mpsc, thread};

fn fixture() -> (super::super::tests::Sandbox, TcpListener, LocalDaemon) {
    let sandbox = super::super::tests::Sandbox::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let path = sandbox.0.join("daemon.json");
    let record = serde_json::json!({"pid":123,"port":listener.local_addr().unwrap().port(),"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"fixture-secret"});
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap()
        .write_all(record.to_string().as_bytes())
        .unwrap();
    let (record, fingerprint) = super::super::record::read(&path).unwrap();
    let daemon = LocalDaemon {
        base_url: record.endpoint().unwrap(),
        record,
        fingerprint,
        path,
        agent: super::super::agent(),
    };
    (sandbox, listener, daemon)
}
fn resource(daemon: &LocalDaemon) -> serde_json::Value {
    serde_json::json!({"daemon":{"protocolVersion":4,"productVersion":daemon.record.product_version,"instanceId":daemon.record.instance_id,"startedAt":daemon.record.started_at},"revision":"a".repeat(64),"registry":{"version":1,"machines":[]}})
}
fn request(listener: &TcpListener) -> (TcpStream, String) {
    listener.set_nonblocking(true).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut socket = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                assert!(std::time::Instant::now() < deadline);
                thread::sleep(Duration::from_millis(2));
            }
            Err(e) => panic!("{e}"),
        }
    };
    socket.set_nonblocking(false).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut b = [0];
        socket.read_exact(&mut b).unwrap();
        bytes.push(b[0]);
        assert!(bytes.len() < 8192);
    }
    (socket, String::from_utf8(bytes).unwrap())
}
fn response(socket: &mut TcpStream, body: &str) {
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .unwrap();
}
fn identity(listener: &TcpListener, body: &str) {
    let (mut socket, headers) = request(listener);
    assert!(headers.starts_with("GET /identity "));
    assert!(!headers.to_ascii_lowercase().contains("authorization:"));
    response(&mut socket, body);
}
fn identity_body(daemon: &LocalDaemon) -> String {
    let mut value = resource(daemon)["daemon"].clone();
    value["ok"] = true.into();
    value["pid"] = 123.into();
    value.to_string()
}
#[test]
fn watch_decoding_requires_generation_and_valid_heartbeat_revision() {
    let (_sandbox, _listener, daemon) = fixture();
    let mut value = resource(&daemon);
    let decode = |v: &serde_json::Value, after| {
        daemon.machine_watch_resource(v.to_string().as_bytes(), after)
    };
    assert!(decode(&value, None).unwrap().registry.is_some());
    value["registry"] = serde_json::Value::Null;
    assert!(decode(&value, None).is_err());
    let revision = "a".repeat(64);
    assert!(
        decode(&value, Some(revision.as_str()))
            .unwrap()
            .registry
            .is_none()
    );
    value.as_object_mut().unwrap().remove("registry");
    assert!(decode(&value, Some(revision.as_str())).is_err());
    value = resource(&daemon);
    value["daemon"]["instanceId"] = uuid::Uuid::new_v4().to_string().into();
    assert!(matches!(decode(&value, None), Err(Error::IdentityChanged)));
    value = resource(&daemon);
    value["revision"] = "A".repeat(64).into();
    assert!(decode(&value, None).is_err());
    value = resource(&daemon);
    value["registry"]["unexpected"] = true.into();
    assert!(decode(&value, None).is_err());
    assert!(
        daemon
            .machine_watch_resource(&vec![b' '; 65537], None)
            .is_err()
    );
}
#[test]
fn watch_uses_owner_request_and_accepts_fragmented_chunked_response() {
    let (_sandbox, listener, daemon) = fixture();
    let identity_json = identity_body(&daemon);
    let body = resource(&daemon).to_string();
    let server = thread::spawn(move || {
        identity(&listener, &identity_json);
        let (mut socket, headers) = request(&listener);
        assert!(headers.starts_with("GET /api/resources/saved-machines/watch?expectedInstanceId=d9c81ebd-5785-45a3-9206-a2aa497d68fc&after="));
        assert!(headers.contains("Bearer fixture-secret"));
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        for chunk in body.as_bytes().chunks(7) {
            write!(socket, "{:x}\r\n", chunk.len()).unwrap();
            socket.write_all(chunk).unwrap();
            socket.write_all(b"\r\n").unwrap();
        }
        socket.write_all(b"0\r\n\r\n").unwrap();
    });
    let update = daemon
        .watch_saved_machines(Some(&"b".repeat(64)), &Default::default())
        .unwrap();
    assert_eq!(update.revision, "a".repeat(64));
    assert!(update.registry.unwrap().machines.is_empty());
    server.join().unwrap();
}
#[test]
fn cancellation_interrupts_pending_body_and_forbids_reuse() {
    let (_sandbox, listener, daemon) = fixture();
    let identity_json = identity_body(&daemon);
    let (ready, started) = mpsc::sync_channel(1);
    let (closed, observed_close) = mpsc::sync_channel(1);
    let server = thread::spawn(move || {
        identity(&listener, &identity_json);
        let (mut socket, _) = request(&listener);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
            .unwrap();
        ready.send(()).unwrap();
        let mut b = [0];
        // Closing with unread response bytes may produce RST instead of FIN.
        // Both prove cancellation closed the socket; timeout/data must fail.
        match socket.read(&mut b) {
            Ok(0) => {}
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
            other => panic!("expected canceled socket closure, got {other:?}"),
        }
        closed.send(()).unwrap();
    });
    let cancellation = MachineWatchCancellation::default();
    let stop = cancellation.clone();
    let (done, result) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let outcome = daemon.watch_saved_machines(None, &cancellation);
        assert!(matches!(outcome, Err(Error::Retired)));
        assert!(matches!(
            daemon.watch_saved_machines(None, &cancellation),
            Err(Error::Retired)
        ));
        done.send(()).unwrap();
    });
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    stop.cancel();
    result.recv_timeout(Duration::from_secs(2)).unwrap();
    observed_close.recv_timeout(Duration::from_secs(2)).unwrap();
    worker.join().unwrap();
    server.join().unwrap();
}
