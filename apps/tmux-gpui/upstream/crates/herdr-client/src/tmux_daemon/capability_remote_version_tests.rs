//! A daemon over SSH gets the gates a local daemon of its version gets: the
//! version is the one its identity proof matched on the route's sockets.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::{
    tmux_daemon::owner::Owner,
    tmux_handoff::ServerScope,
    tmux_ssh::{RemoteDescriptor, RemoteTransport},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
    thread,
    time::Duration,
};
const INSTANCE: &str = "d9c81ebd-5785-45a3-9206-a2aa497d68fc";
fn identity(version: &str) -> Value {
    json!({"ok":true,"pid":123,"protocolVersion":4,"productVersion":version,"instanceId":INSTANCE,"startedAt":"2026-10-25T02:00:00Z"})
}
pub(super) fn descriptor(version: &str) -> RemoteDescriptor {
    let mut daemon = identity(version);
    daemon.as_object_mut().unwrap().remove("ok");
    daemon["port"] = 4111.into();
    daemon["bindHostname"] = "127.0.0.1".into();
    daemon["authToken"] = "secret-fixture".into();
    RemoteDescriptor::parse(
        &serde_json::to_vec(&json!({"version":1,"daemon":daemon})).unwrap(),
        None,
    )
    .unwrap()
}
fn scope() -> ServerScope {
    ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: INSTANCE.into(),
    }
}
fn request(stream: &mut TcpStream) -> (String, Vec<u8>) {
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
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    (first, body)
}
fn reply(stream: &mut TcpStream, body: &Value) {
    let bytes = serde_json::to_vec(body).unwrap();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
        bytes.len()
    )
    .unwrap();
    stream.write_all(&bytes).unwrap();
}
fn selection(window: Option<&str>) -> TerminalSelection {
    TerminalSelection {
        workspace_name: "fixture".into(),
        live_session_id: format!("live-session.{}", "a".repeat(20)),
        selected_pane: "pane.first".into(),
        visible_panes: vec!["pane.first".into()],
        mode: ViewerMode::Interactive,
        window: window.map(str::to_owned),
    }
}
/// What the remote daemon was asked: the sessions resource version and the
/// issue request's stream.
struct Asked {
    sessions_version: String,
    stream: Value,
}
/// One remote daemon of `version` behind a fixture route: select the server,
/// list sessions and issue an interactive terminal stream, windowed where the
/// version allows it.
fn ask_remote(version: &str, windowed: bool) -> (Option<String>, bool, Asked) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = identity(version);
    let server = thread::spawn(move || {
        let (mut http, _) = listener.accept().unwrap();
        let (path, _) = request(&mut http);
        assert!(path.starts_with("GET /identity "), "{path}");
        reply(&mut http, &served);
        let (path, _) = request(&mut http);
        assert!(path.starts_with("GET /api/v1/tmux-servers "), "{path}");
        let scope = scope();
        reply(
            &mut http,
            &json!({"version":1,"servers":[{"state":"online","serverId":scope.server_id,"label":"Remote","generation":INSTANCE}]}),
        );
        let (path, _) = request(&mut http);
        let sessions_version = path
            .split("sessions?version=")
            .nth(1)
            .and_then(|rest| rest.split(' ').next())
            .unwrap()
            .to_owned();
        let mut session = json!({"liveSessionId":format!("live-session.{}", "a".repeat(20)),"sessionName":"remote","workspaceName":null,"paneCount":30,"windowCount":2});
        if sessions_version == "3" {
            session["largestWindowPaneCount"] = 20.into();
        }
        reply(
            &mut http,
            &json!({"version":sessions_version.parse::<u8>().unwrap(),"server":{"serverId":scope.server_id,"generation":INSTANCE},"sessions":[session]}),
        );
        let (path, body) = request(&mut http);
        assert!(path.starts_with("POST "), "{path}");
        let body: Value = serde_json::from_slice(&body).unwrap();
        let id = body["requestId"].as_str().unwrap().to_owned();
        reply(
            &mut http,
            &json!({"status":"issued","descriptor":{"protocolVersion":2,"webSocketUrl":"ws://127.0.0.1:4111/v2/terminal/pane-streams/redeem","subprotocol":crate::tmux_stream::SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":INSTANCE,"requestId":id,"expiresAt":9999999999999u64,"panes":["pane.first"],"effectiveViewerMode":"interactive"}}),
        );
        Asked {
            sessions_version,
            stream: body["stream"].clone(),
        }
    });
    let route = Arc::new(RemoteTransport::fixture(port, descriptor(version)).unwrap());
    let owner = Owner::Remote(route.clone());
    let client = owner.select_server(&scope()).unwrap();
    let product_version = client.product_version();
    let window_streams = client.window_streams();
    assert_eq!(client.sessions().unwrap().len(), 1);
    let window = windowed.then_some("window.two");
    let handoff = client.issue_terminal(&selection(window)).unwrap();
    assert!(handoff.local_images.is_none() && !handoff.native_surfaces);
    assert_eq!(handoff.daemon_version, product_version);
    let asked = server.join().unwrap();
    drop(client);
    drop(owner);
    let Ok(route) = Arc::try_unwrap(route) else {
        panic!("route retained")
    };
    route.shutdown_fixture().unwrap();
    (product_version, window_streams, asked)
}
/// The offer a local daemon of `version` gets for this stream, given what an
/// SSH route can never carry: local image files and native surfaces.
fn local_offer(version: Option<&str>) -> Vec<u32> {
    issue_versions(true, false, false, true, version)
}
#[test]
fn a_remote_daemon_gets_the_gates_of_its_proven_version() {
    let before = json!([1, 101, 113, 118, 103, 104, 105, 106, 119]);
    let since_2_9_26 = json!([1, 101, 113, 118, 103, 104, 105, 106, 119, 123]);
    // 2.9.27 adds history on demand (122) and pipelined delivery (124).
    let since_2_9_27 = json!([1, 101, 113, 118, 103, 104, 105, 106, 119, 123, 122, 124]);
    for (version, windows, offer) in [
        ("2.9.24", false, &before),
        ("2.9.25", false, &before),
        ("2.9.26", true, &since_2_9_26),
        ("2.9.27", true, &since_2_9_27),
        // A build that is not a release stays conservative, as it does locally.
        ("2.9.27-rc.1", false, &before),
    ] {
        let (product_version, window_streams, asked) = ask_remote(version, windows);
        assert_eq!(product_version.as_deref(), Some(version));
        assert_eq!(window_streams, knows_window_streams(Some(version)));
        assert_eq!(window_streams, windows, "{version}");
        assert_eq!(
            asked.sessions_version,
            if windows { "3" } else { "2" },
            "{version}"
        );
        let offered = &asked.stream["terminalDelivery"]["protocolVersions"];
        assert_eq!(offered, offer, "{version}");
        assert_eq!(offered, &json!(local_offer(Some(version))), "{version}");
        assert_eq!(
            asked.stream.get("semanticWindowId"),
            windows.then(|| json!("window.two")).as_ref(),
            "{version}"
        );
    }
}
/// A version the daemon behind the tunnel does not prove on its socket is
/// never used: the route does not open at all.
#[test]
fn a_version_the_tunnelled_daemon_does_not_prove_opens_no_route() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut http, _) = listener.accept().unwrap();
        let (path, _) = request(&mut http);
        assert!(path.starts_with("GET /identity "), "{path}");
        reply(&mut http, &identity("2.9.24"));
    });
    assert!(RemoteTransport::fixture(port, descriptor("2.9.27")).is_err());
    server.join().unwrap();
}
