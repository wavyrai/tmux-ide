#![allow(clippy::unwrap_used)]
use super::*;
use std::{net::TcpListener, thread};
fn fixture() -> (PeerIdentity, Vec<u8>) {
    let value = serde_json::json!({"pid":123,"port":4111,"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"secret-fixture"});
    let descriptor = super::super::RemoteDescriptor::parse(
        &serde_json::to_vec(&serde_json::json!({"version":1,"daemon":value})).unwrap(),
        None,
    )
    .unwrap();
    let mut response = value;
    response["ok"] = true.into();
    (
        descriptor.peer_identity(),
        serde_json::to_vec(&response).unwrap(),
    )
}
#[test]
fn chunked_identity_preserves_the_original_socket_for_upgrade() {
    let (expected, body) = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        let request = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /identity "));
        assert!(!request.contains("authorization"));
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(&body).unwrap();
        stream.write_all(b"\r\n0\r\n\r\n").unwrap();
        let mut after = [0; 7];
        stream.read_exact(&mut after).unwrap();
        assert_eq!(&after, b"UPGRADE");
    });
    verify_socket_identity(&socket, &expected, Duration::from_secs(2)).unwrap();
    (&socket).write_all(b"UPGRADE").unwrap();
    server.join().unwrap();
}
#[test]
fn mismatched_or_trailing_identity_is_rejected() {
    for trailing in [false, true] {
        let (expected, mut body) = fixture();
        if !trailing {
            body = b"{\"ok\":false}".to_vec();
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            let mut response =
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
            response.extend(body);
            if trailing {
                response.extend(b"unsolicited");
            }
            stream.write_all(&response).unwrap();
        });
        let result = verify_socket_identity(&socket, &expected, Duration::from_secs(2));
        assert!(matches!(
            result,
            Err(IdentityError::Mismatch | IdentityError::Trailing)
        ));
        server.join().unwrap();
    }
}
