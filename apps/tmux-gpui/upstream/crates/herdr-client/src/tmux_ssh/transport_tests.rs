#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn cancelled_or_expired_route_never_starts_ssh() {
    let target = SshTarget::parse("no-network-fixture.invalid").unwrap();
    let result = RemoteTransport::connect(
        &target,
        None,
        &AtomicBool::new(true),
        Instant::now() + Duration::from_secs(2),
    );
    assert!(matches!(result, Err(TransportError::Cancelled)));
    let result = RemoteTransport::connect(&target, None, &AtomicBool::new(false), Instant::now());
    assert!(matches!(result, Err(TransportError::Timeout)));
}

#[test]
fn owned_route_authenticates_and_retirement_fences_further_requests() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        process::Command,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let identity = serde_json::json!({"ok":true,"pid":123,"protocolVersion":4,"productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc","startedAt":"2026-10-25T02:00:00Z"});
    let mut daemon = identity.clone();
    daemon.as_object_mut().unwrap().remove("ok");
    daemon["port"] = 4111.into();
    daemon["bindHostname"] = "127.0.0.1".into();
    daemon["authToken"] = "secret-fixture".into();
    let descriptor = Arc::new(
        RemoteDescriptor::parse(
            &serde_json::to_vec(&serde_json::json!({"version":1,"daemon":daemon})).unwrap(),
            None,
        )
        .unwrap(),
    );
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        for (path, body, auth) in [
            ("/identity", serde_json::to_vec(&identity).unwrap(), false),
            ("/api/v2/capabilities", b"{}".to_vec(), true),
        ] {
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                bytes.push(byte[0]);
                assert!(bytes.len() < 8192);
            }
            let request = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
            assert!(request.starts_with(&format!("get {path} ")));
            assert_eq!(
                request.contains("authorization: bearer secret-fixture"),
                auth
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    // The fixture supplies the forward socket; this owned local child exercises
    // lifecycle only. It is deliberately not a real SSH/network qualification.
    let mut command = Command::new("/bin/sleep");
    command.arg("60");
    let tunnel = Tunnel::spawn_command(command, port).unwrap();
    let cancelled = AtomicBool::new(false);
    let route = RemoteTransport::finish_connect(
        tunnel,
        descriptor,
        &cancelled,
        Instant::now() + Duration::from_secs(3),
    )
    .unwrap();
    assert!(!route.generation().is_nil());
    assert_eq!(route.capabilities(&cancelled).unwrap(), b"{}");
    route.retire();
    assert!(matches!(
        route.capabilities(&cancelled),
        Err(TransportError::Tunnel(TunnelError::Retired))
    ));
    let RemoteTransport {
        connection, tunnel, ..
    } = route;
    drop(connection);
    let Ok(tunnel) = Arc::try_unwrap(tunnel) else {
        panic!("tunnel retained")
    };
    tunnel.shutdown().unwrap();
    server.join().unwrap();
}

#[test]
#[ignore = "requires the owned localhost OpenSSH harness"]
fn owned_openssh_discovery_and_capabilities() {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_OWNED_SSH").as_deref(),
        Ok("private-fixture")
    );
    let target = SshTarget::parse("target").unwrap();
    let route = RemoteTransport::connect(
        &target,
        None,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(15),
    )
    .unwrap();
    let bytes = route.capabilities(&AtomicBool::new(false)).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value, serde_json::json!({"nativeFixture":true}));
    route.retire();
    assert!(route.capabilities(&AtomicBool::new(false)).is_err());
    route.shutdown_fixture().unwrap();
}
