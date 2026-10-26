#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
};
fn identity() -> serde_json::Value {
    serde_json::json!({"ok":true,"pid":123,"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z"})
}
fn descriptor() -> RemoteDescriptor {
    let mut daemon = identity();
    daemon.as_object_mut().unwrap().remove("ok");
    daemon["port"] = 4111.into();
    daemon["bindHostname"] = "127.0.0.1".into();
    daemon["authToken"] = "secret-fixture".into();
    RemoteDescriptor::parse(
        &serde_json::to_vec(&serde_json::json!({"version":1,"daemon":daemon})).unwrap(),
        None,
    )
    .unwrap()
}
fn request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut b = [0];
        if stream.read(&mut b).unwrap() == 0 {
            break;
        }
        bytes.push(b[0]);
        assert!(bytes.len() < 8192);
    }
    String::from_utf8(bytes).unwrap()
}
fn reply(stream: &mut TcpStream, body: &[u8], close: bool) {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n",
        body.len(),
        if close { "close" } else { "keep-alive" }
    )
    .unwrap();
    stream.write_all(body).unwrap();
}
#[test]
fn credentials_only_follow_identity_on_the_same_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let first = request(&mut stream);
        assert!(first.starts_with("GET /identity "));
        assert!(!first.to_ascii_lowercase().contains("authorization"));
        reply(
            &mut stream,
            &serde_json::to_vec(&identity()).unwrap(),
            false,
        );
        let next = request(&mut stream);
        assert!(next.starts_with("GET /api/v2/capabilities "));
        assert!(
            next.to_ascii_lowercase()
                .contains("authorization: bearer secret-fixture")
        );
        reply(&mut stream, b"{}", false);
    });
    let connection = VerifiedConnection::connect(port, descriptor()).unwrap();
    assert_eq!(connection.capabilities().unwrap(), b"{}");
    server.join().unwrap();
}
#[test]
fn closed_verified_socket_cannot_reconnect_with_credentials() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        request(&mut stream);
        reply(&mut stream, &serde_json::to_vec(&identity()).unwrap(), true);
        drop(stream);
        listener
    });
    let connection = VerifiedConnection::connect(port, descriptor()).unwrap();
    let listener = server.join().unwrap();
    assert!(matches!(
        connection.capabilities(),
        Err(ConnectionError::Network(_))
    ));
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}
#[test]
fn mismatched_identity_never_receives_credentials() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        request(&mut stream);
        let mut wrong = identity();
        wrong["productVersion"] = "other".into();
        reply(&mut stream, &serde_json::to_vec(&wrong).unwrap(), false);
        assert!(request(&mut stream).is_empty());
    });
    assert!(matches!(
        VerifiedConnection::connect(port, descriptor()),
        Err(ConnectionError::Identity)
    ));
    server.join().unwrap();
}
