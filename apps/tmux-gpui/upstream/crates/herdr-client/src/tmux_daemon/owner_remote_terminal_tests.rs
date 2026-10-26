#![allow(clippy::unwrap_used)]
use super::*;
use crate::{
    tmux_daemon::TerminalSelection,
    tmux_handoff::ServerScope,
    tmux_stream::{Event, PaneStream, SUBPROTOCOL, ViewerMode},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
};
const INSTANCE: &str = "d9c81ebd-5785-45a3-9206-a2aa497d68fc";
fn request(stream: &mut TcpStream) -> (String, HashMap<String, String>, Vec<u8>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 16384);
    }
    let head = String::from_utf8(bytes).unwrap();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap().to_owned();
    let headers: HashMap<_, _> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length = headers
        .get("content-length")
        .map_or(0, |v| v.parse::<usize>().unwrap());
    assert!(length < 16384);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    (first, headers, body)
}
fn reply(stream: &mut TcpStream, body: Value) {
    let bytes = serde_json::to_vec(&body).unwrap();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
        bytes.len()
    )
    .unwrap();
    stream.write_all(&bytes).unwrap();
}
#[test]
fn remote_catalog_issue_reaches_identity_verified_terminal_without_helper() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let identity = json!({"ok":true,"pid":123,"protocolVersion":4,"productVersion":"2.9.12","instanceId":INSTANCE,"startedAt":"2026-10-25T02:00:00Z"});
    let mut daemon = identity.clone();
    daemon.as_object_mut().unwrap().remove("ok");
    daemon["port"] = 4111.into();
    daemon["bindHostname"] = "127.0.0.1".into();
    daemon["authToken"] = "secret-fixture".into();
    let descriptor = crate::tmux_ssh::RemoteDescriptor::parse(
        &serde_json::to_vec(&json!({"version":1,"daemon":daemon})).unwrap(),
        None,
    )
    .unwrap();
    let scope = ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: INSTANCE.into(),
    };
    let served = scope.clone();
    let server = thread::spawn(move || {
        let (mut http, _) = listener.accept().unwrap();
        let (path, headers, _) = request(&mut http);
        assert!(path.starts_with("GET /identity "));
        assert!(!headers.contains_key("authorization"));
        reply(&mut http, identity.clone());
        let (path, headers, _) = request(&mut http);
        assert!(path.starts_with("GET /api/v1/tmux-servers "));
        assert_eq!(headers["authorization"], "Bearer secret-fixture");
        reply(
            &mut http,
            json!({"version":1,"servers":[{"state":"online","serverId":served.server_id,"label":"Remote","generation":INSTANCE}]}),
        );
        let (path, headers, body) = request(&mut http);
        assert!(path.starts_with(&format!(
            "POST /api/v1/tmux-servers/{}/{}/pane-streams/issue?",
            served.server_id, INSTANCE
        )));
        assert_eq!(headers["authorization"], "Bearer secret-fixture");
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body["stream"]["terminalDelivery"]["protocolVersions"],
            json!([1, 101, 113, 102, 103, 104, 105, 106])
        );
        let id = body["requestId"].as_str().unwrap().to_owned();
        let host = headers["x-tmux-ide-host-client-id"].clone();
        reply(
            &mut http,
            json!({"status":"issued","descriptor":{"protocolVersion":2,"webSocketUrl":"ws://127.0.0.1:4111/v2/terminal/pane-streams/redeem","subprotocol":SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":INSTANCE,"requestId":id,"expiresAt":9999999999999u64,"panes":["pane.first"],"effectiveViewerMode":"interactive"}}),
        );
        let (mut stream, _) = listener.accept().unwrap();
        let (path, headers, _) = request(&mut stream);
        assert!(path.starts_with("GET /identity "));
        assert!(!headers.contains_key("authorization") && !headers.contains_key("upgrade"));
        reply(&mut stream, identity);
        #[allow(clippy::result_large_err)]
        fn upgrade(
            _: &tungstenite::handshake::server::Request,
            mut response: tungstenite::handshake::server::Response,
        ) -> Result<
            tungstenite::handshake::server::Response,
            tungstenite::handshake::server::ErrorResponse,
        > {
            response
                .headers_mut()
                .insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
            Ok(response)
        }
        let mut ws = tungstenite::accept_hdr(stream, upgrade).unwrap();
        let redemption: Value =
            serde_json::from_str(&ws.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(redemption["requestId"], id);
        assert_eq!(redemption["ticket"], format!("ps2_{}", "a".repeat(43)));
        ws.send(tungstenite::Message::Text(json!({"type":"ready","protocolVersion":2,"requestId":id,"daemonInstanceId":INSTANCE,"connectionClientId":host,"panes":["pane.first"],"effectiveViewerMode":"interactive","inputLifetime":true}).to_string().into())).unwrap();
    });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    let owner = Owner::Remote(route.clone());
    let client = owner.select_server(&scope).unwrap();
    let handoff = client
        .issue_terminal(&TerminalSelection {
            workspace_name: "fixture".into(),
            live_session_id: format!("live-session.{}", "a".repeat(20)),
            selected_pane: "pane.first".into(),
            visible_panes: vec!["pane.first".into()],
            mode: ViewerMode::Interactive,
        })
        .unwrap();
    assert!(handoff.remote_peer.is_some());
    assert!(handoff.local_images.is_none());
    assert_eq!(
        url::Url::parse(&handoff.descriptor.web_socket_url)
            .unwrap()
            .port(),
        Some(port)
    );
    let (options, _, _) = handoff.into_connection();
    let stream = PaneStream::spawn(options).unwrap();
    assert!(matches!(
        stream
            .events()
            .recv_timeout(Duration::from_secs(3))
            .unwrap(),
        Event::Ready(_)
    ));
    stream.cancel();
    server.join().unwrap();
    drop(client);
    drop(owner);
    let Ok(route) = Arc::try_unwrap(route) else {
        panic!("route retained")
    };
    route.shutdown_fixture().unwrap();
}

#[test]
#[ignore = "requires the owned OpenSSH and scratch daemon harness"]
fn owned_openssh_real_daemon_terminal() {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_OWNED_SSH").as_deref(),
        Ok("private-fixture")
    );
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_ALLOW_MUTATION").as_deref(),
        Ok("owned-scratch-fleet")
    );
    let name = std::env::var("TMUX_IDE_TEST_INPUT_SESSION").unwrap();
    let route = Arc::new(
        crate::tmux_ssh::RemoteTransport::connect(
            &crate::tmux_ssh::SshTarget::parse("target").unwrap(),
            None,
            &std::sync::atomic::AtomicBool::new(false),
            std::time::Instant::now() + Duration::from_secs(15),
        )
        .unwrap(),
    );
    let owner = Owner::Remote(route.clone());
    let servers = owner.list_servers().unwrap();
    let scopes: Vec<_> = servers
        .iter()
        .filter_map(|server| match server {
            ServerRegistration::Online { scope, .. } => Some(scope),
            _ => None,
        })
        .collect();
    assert_eq!(scopes.len(), 1);
    let client = owner.select_server(scopes[0]).unwrap();
    let session = client
        .sessions()
        .unwrap()
        .into_iter()
        .find(|session| session.session_name == name)
        .unwrap();
    let workspace = client.open_session(&session.live_session_id).unwrap();
    let agents = client
        .observe_agents(&session.live_session_id, &workspace)
        .unwrap();
    assert_eq!(agents.scope, *scopes[0]);
    assert_eq!(agents.live_session_id, session.live_session_id);
    assert_eq!(agents.workspace_name, workspace);
    assert!(agents.agents.is_empty());
    let panes = client
        .workspace_panes(&session.live_session_id, &workspace)
        .unwrap();
    assert!(!panes.is_empty());
    let handoff = client
        .issue_terminal(&TerminalSelection {
            workspace_name: workspace,
            live_session_id: session.live_session_id,
            selected_pane: panes[0].clone(),
            visible_panes: panes,
            mode: ViewerMode::ReadOnly,
        })
        .unwrap();
    assert!(handoff.remote_peer.is_some() && handoff.local_images.is_none());
    let offered = (
        handoff.graphics,
        handoff.binary_cells,
        handoff.alternate_screen_projection,
    );
    let (options, workspace, pane) = handoff.into_connection();
    if std::env::var("TMUX_IDE_TEST_GRAPHICS").as_deref() == Ok("owned-pixels") {
        use crate::tmux_native_session::{GraphicsEvent, NativeSession};
        use std::sync::atomic::Ordering;
        let before = crate::tmux_graphics::COMPRESSED_CHUNKS.load(Ordering::Relaxed);
        let session =
            NativeSession::spawn_offered(options, workspace, offered.0, None, offered.1, offered.2)
                .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut announced = false;
        let mut received = Vec::new();
        let mut complete = false;
        while !complete {
            let update = session.drain().unwrap();
            if let crate::tmux_native_session::Status::Failed(error) = &update.status {
                panic!(
                    "SSH graphics failed: {error}; cause={}",
                    std::error::Error::source(error.as_ref())
                        .map_or_else(|| "none".into(), ToString::to_string)
                );
            }
            assert!(
                std::time::Instant::now() < deadline,
                "SSH graphics deadline; status={:?}, bytes={}",
                update.status,
                received.len()
            );
            if !announced && session.committed(&pane).unwrap().is_some() {
                announced = true;
                println!("NATIVE_SSH_GRAPHICS_READY");
                std::io::stdout().flush().unwrap();
            }
            for event in update.graphics {
                if let GraphicsEvent::Chunk(chunk) = event {
                    assert_eq!(chunk.metadata.blob.offset, received.len());
                    assert_eq!(chunk.metadata.blob.total, 256 * 1024 * 4);
                    assert_eq!(
                        chunk.metadata.blob.format,
                        crate::tmux_graphics::Format::Rgba
                    );
                    received.extend(chunk.bytes);
                    complete = chunk.complete_verified;
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(received, vec![42; 256 * 1024 * 4]);
        let chunks = crate::tmux_graphics::COMPRESSED_CHUNKS.load(Ordering::Relaxed) - before;
        assert!(
            chunks >= 2,
            "expected multiple actual TGB2 chunks, got {chunks}"
        );
        assert!(session.committed(&pane).unwrap().is_some());
        session.cancel();
        drop(session);
        println!(
            "NATIVE_SSH_GRAPHICS_VERIFIED bytes={} compressed_chunks={chunks}",
            received.len()
        );
    } else {
        let stream = PaneStream::spawn(options).unwrap();
        assert!(matches!(
            stream
                .events()
                .recv_timeout(Duration::from_secs(10))
                .unwrap(),
            Event::Ready(_)
        ));
        stream.cancel();
        let _ = stream
            .completion()
            .recv_timeout(Duration::from_secs(3))
            .unwrap();
    }
    drop(client);
    drop(owner);
    let Ok(route) = Arc::try_unwrap(route) else {
        panic!("route retained")
    };
    route.shutdown_fixture().unwrap();
}
