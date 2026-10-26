#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::OpenOptionsExt,
    thread,
};

fn identity_request(listener: &TcpListener) -> TcpStream {
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut socket = loop {
        match listener.accept() {
            Ok((socket, _)) => break socket,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
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
        let mut byte = [0];
        socket.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 8192);
    }
    let request = String::from_utf8(bytes).unwrap().to_lowercase();
    assert!(request.starts_with("get /identity "));
    assert!(!request.contains("authorization"));
    socket
}
#[test]
#[allow(clippy::result_large_err)]
fn same_socket_proof_gates_registration_and_drop_closes_owner() {
    for mismatch in [false, true] {
        let sandbox = super::super::tests::Sandbox::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let generation = Uuid::new_v4();
        let record = json!({"pid":123,"port":listener.local_addr().unwrap().port(),"protocolVersion":4,
            "productVersion":"2.9.12","instanceId":generation,"startedAt":"2026-10-25T02:00:00Z",
            "bindHostname":"127.0.0.1","authToken":"fixture-private"});
        let path = sandbox.0.join("daemon.json");
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(record.to_string().as_bytes())
            .unwrap();
        let server = thread::spawn(move || {
            let mut last = None;
            for index in 0..3 {
                let mut socket = identity_request(&listener);
                let mut body = json!({"pid":123,"ok":true,"protocolVersion":4,"productVersion":"2.9.12",
                    "instanceId":generation,"startedAt":"2026-10-25T02:00:00Z"});
                if mismatch && index == 2 {
                    body["instanceId"] = json!(Uuid::new_v4());
                }
                let body = body.to_string();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n{body}",
                    body.len(),
                    if index == 2 { "keep-alive" } else { "close" }
                )
                .unwrap();
                if index == 2 {
                    last = Some(socket);
                }
            }
            let mut socket = last.unwrap();
            if mismatch {
                let mut byte = [0];
                assert_eq!(socket.read(&mut byte).unwrap(), 0);
                return;
            }
            let mut socket = tungstenite::accept_hdr(
                socket,
                |request: &tungstenite::handshake::server::Request,
                 mut response: tungstenite::handshake::server::Response| {
                    assert_eq!(request.uri().to_string(), wire::PATH);
                    assert_eq!(request.headers()["authorization"], "Bearer fixture-private");
                    assert_eq!(request.headers()["sec-websocket-protocol"], wire::PROTOCOL);
                    response.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        tungstenite::http::HeaderValue::from_static(wire::PROTOCOL),
                    );
                    Ok(response)
                },
            )
            .unwrap();
            let registration: Value =
                serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(
                registration,
                json!({"type":"register","version":1,"generation":generation,"auditToken":[1,1,1,1,1,1,1,1]})
            );
            socket
                .send(Message::Text(
                    json!({"type":"registered","version":1,"generation":generation})
                        .to_string()
                        .into(),
                ))
                .unwrap();
            let connection = Uuid::new_v4();
            socket
                .send(Message::Text(
                    json!({"type":"start","connection":connection,"panes":["pane.editor"],
                "receiver":{"type":"terminal-surface-receiver","version":1,"generation":generation,
                "connectionNonce":Uuid::new_v4(),"challenge":Uuid::new_v4(),"pid":123,"slot":0,
                "auditToken":[2,2,2,2,2,2,2,2]}})
                    .to_string()
                    .into(),
                ))
                .unwrap();
            let submitted: Value =
                serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(submitted["type"], "offer");
            assert_eq!(submitted["connection"], connection.to_string());
            assert_eq!(submitted["offer"]["allocationBytes"], 4096);
            socket
                .send(Message::Text(
                    json!({"type":"offered","connection":connection,"sequence":1,"accepted":true})
                        .to_string()
                        .into(),
                ))
                .unwrap();
            socket
                .send(Message::Text(
                    json!({"type":"retired","connection":connection,"sequence":1})
                        .to_string()
                        .into(),
                ))
                .unwrap();
            assert!(socket.read().is_err());
        });
        let daemon = Arc::new(LocalDaemon::discover(&path).unwrap());
        let result = daemon.connect_surface_provider([1; 8]);
        if mismatch {
            assert!(matches!(result, Err(SurfaceProviderError::Identity(_))));
        } else {
            let mut provider = result.unwrap();
            assert_eq!(provider.generation(), generation);
            let Event::Start { connection, .. } = next(&mut provider) else {
                panic!("start expected");
            };
            provider.submit(submission(connection, generation)).unwrap();
            assert!(matches!(
                next(&mut provider),
                Event::Offered {
                    sequence: 1,
                    accepted: true,
                    ..
                }
            ));
            assert!(matches!(
                next(&mut provider),
                Event::Retired { sequence: 1, .. }
            ));
            drop(provider);
        }
        server.join().unwrap();
    }
}

fn next(provider: &mut SurfaceProvider) -> Event {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(event) = provider.poll().unwrap() {
            return event;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
}
fn submission(
    connection: Uuid,
    generation: Uuid,
) -> crate::tmux_graphics::surface_provider_offer::Submission {
    use crate::{
        tmux_delivery::{Update, decode_compact},
        tmux_graphics::{
            surface_leases::Layout,
            surface_offer::Placement,
            surface_provider_offer::{Frame, Submission},
        },
        tmux_native_session::{CommittedIdentity, CommittedPane},
    };
    let vectors: Value =
        serde_json::from_str(include_str!("../tmux_graphics/tests/vectors.json")).unwrap();
    let Update::Seed { snapshot, .. } =
        decode_compact(vectors["cases"][0]["wire"].as_str().unwrap().as_bytes()).unwrap()
    else {
        panic!("seed");
    };
    let pane = CommittedPane {
        snapshot: Some(Arc::new(snapshot)),
        identity: Arc::new(CommittedIdentity {
            generation: generation.to_string(),
            incarnation: "pane:1".into(),
            delivery_nonce: Uuid::new_v4().to_string(),
            canonical_revision: 1,
            canonical_state_hash: "0000000000000001".into(),
        }),
    };
    Submission::new(
        connection,
        "pane.editor",
        &pane,
        Frame {
            sequence: 1,
            surface_id: Uuid::new_v4(),
            storage_ticket: Uuid::new_v4(),
            layout: Layout {
                width: 16,
                height: 16,
                stride: 256,
                allocation_bytes: 4096,
            },
            placement: Placement {
                row: 0,
                column: 0,
                rows: 1,
                columns: 1,
            },
        },
    )
    .unwrap()
}
