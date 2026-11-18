#![allow(clippy::unwrap_used, clippy::type_complexity)]
use super::*;
use crate::tmux_stream::{ConnectOptions, Event, IssuedDescriptor, PaneStream, SUBPROTOCOL};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread::JoinHandle,
};
use tungstenite::handshake::server::{Request, Response};
const INSTANCE: &str = "d9c81ebd-5785-45a3-9206-a2aa497d68fc";

fn identity() -> Value {
    json!({"ok":true,"pid":123,"protocolVersion":4,"productVersion":"2.9.27","instanceId":INSTANCE,"startedAt":"2026-10-25T02:00:00Z"})
}
fn peer() -> PeerIdentity {
    let mut daemon = identity();
    daemon.as_object_mut().unwrap().remove("ok");
    daemon["port"] = 4111.into();
    daemon["bindHostname"] = "127.0.0.1".into();
    daemon["authToken"] = "secret-fixture".into();
    crate::tmux_ssh::RemoteDescriptor::parse(
        &serde_json::to_vec(&json!({"version":1,"daemon":daemon})).unwrap(),
        None,
    )
    .unwrap()
    .peer_identity()
}
/// Read one HTTP request head; answer `/identity` with `body`.
fn answer_identity(stream: &mut TcpStream, body: &Value) -> String {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
    }
    let bytes = serde_json::to_vec(body).unwrap();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
        bytes.len()
    )
    .unwrap();
    stream.write_all(&bytes).unwrap();
    String::from_utf8(head).unwrap()
}

#[test]
fn a_prepared_socket_is_the_proven_connection_itself() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let prepared = PreparedSocket::spawn(port, peer(), Duration::from_secs(2));
    let (mut accepted, _) = listener.accept().unwrap();
    let head = answer_identity(&mut accepted, &identity());
    assert!(head.starts_with("GET /identity "));
    assert!(!head.to_ascii_lowercase().contains("authorization"));
    let mut socket = prepared
        .take(port, &peer(), Duration::from_secs(2))
        .unwrap();
    socket.set_nonblocking(false).unwrap();
    socket.write_all(b"same socket").unwrap();
    let mut read = [0; 11];
    accepted.read_exact(&mut read).unwrap();
    assert_eq!(&read, b"same socket");
}

#[test]
fn a_prepared_socket_is_refused_unless_proven_fresh_and_open_for_this_port_and_peer() {
    // Another daemon answered: no socket.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let prepared = PreparedSocket::spawn(port, peer(), Duration::from_secs(2));
    let (mut accepted, _) = listener.accept().unwrap();
    let mut other = identity();
    other["instanceId"] = "0e7a8a7c-1a6b-4c35-9a41-6f1a4b6c7d8e".into();
    answer_identity(&mut accepted, &other);
    assert!(
        prepared
            .take(port, &peer(), Duration::from_secs(2))
            .is_none()
    );

    // Proven, but asked for another port: no socket.
    let prepared = PreparedSocket::spawn(port, peer(), Duration::from_secs(2));
    let (mut accepted, _) = listener.accept().unwrap();
    answer_identity(&mut accepted, &identity());
    assert!(
        prepared
            .take(port + 1, &peer(), Duration::from_secs(2))
            .is_none()
    );

    // Proven, then closed by the daemon: no socket.
    let prepared = PreparedSocket::spawn(port, peer(), Duration::from_secs(2));
    let (mut accepted, _) = listener.accept().unwrap();
    answer_identity(&mut accepted, &identity());
    drop(accepted);
    thread::sleep(Duration::from_millis(100));
    assert!(
        prepared
            .take(port, &peer(), Duration::from_secs(2))
            .is_none()
    );

    // Nothing listening: no socket, and no wait beyond the dial.
    drop(listener);
    let prepared = PreparedSocket::spawn(port, peer(), Duration::from_secs(2));
    assert!(
        prepared
            .take(port, &peer(), Duration::from_secs(2))
            .is_none()
    );
}

fn options(port: u16, redeem_in_upgrade: bool) -> (ConnectOptions, String) {
    let request = uuid::Uuid::new_v4().to_string();
    let descriptor: IssuedDescriptor = serde_json::from_value(json!({"protocolVersion":2,"webSocketUrl":format!("ws://127.0.0.1:{port}/v2/terminal/pane-streams/redeem"),"subprotocol":SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":INSTANCE,"requestId":request,"expiresAt":9999999999999u64,"panes":["pane.first"],"effectiveViewerMode":"interactive"})).unwrap();
    let host = format!("gpui:{}", uuid::Uuid::new_v4());
    (
        ConnectOptions {
            remote_peer: None,
            descriptor,
            origin: "tmux-ide://app".into(),
            host_client_id: host.clone(),
            upgrade: UpgradeHints {
                prepared: None,
                redeem_in_upgrade,
            },
        },
        host,
    )
}

/// A daemon that answers the upgrade, echoing the carried redeem when `echo`,
/// and reports the carried frame and whether a frame came on the socket.
fn redeem_daemon(echo: bool) -> (u16, JoinHandle<(Option<Value>, Option<Value>)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut carried = None;
        let mut host = String::new();
        #[allow(clippy::result_large_err)]
        let mut ws =
            tungstenite::accept_hdr(stream, |request: &Request, mut response: Response| {
                use base64::Engine as _;
                host = request.headers()["x-tmux-ide-host-client-id"]
                    .to_str()
                    .unwrap()
                    .to_owned();
                carried = request.headers().get("x-tmux-ide-redeem").map(|value| {
                    serde_json::from_slice::<Value>(
                        &base64::engine::general_purpose::URL_SAFE_NO_PAD
                            .decode(value.as_bytes())
                            .unwrap(),
                    )
                    .unwrap()
                });
                let headers = response.headers_mut();
                headers.insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
                if echo && carried.is_some() {
                    headers.insert("X-Tmux-Ide-Redeem", "accepted".parse().unwrap());
                }
                Ok(response)
            })
            .unwrap();
        let carried_frame = carried.clone();
        let redeem = carried_frame.clone();
        let socket_frame = if echo && carried.is_some() {
            None
        } else {
            Some(serde_json::from_str::<Value>(&ws.read().unwrap().into_text().unwrap()).unwrap())
        };
        let frame = redeem.or_else(|| socket_frame.clone()).unwrap();
        ws.send(tungstenite::Message::Text(json!({"type":"ready","protocolVersion":2,"requestId":frame["requestId"],"daemonInstanceId":INSTANCE,"connectionClientId":host,"panes":["pane.first"],"effectiveViewerMode":"interactive","inputLifetime":true}).to_string().into())).unwrap();
        // Anything the client sends after ready, within a moment, would be
        // a second redemption: there must be none.
        ws.get_mut()
            .set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        let later = ws
            .read()
            .ok()
            .and_then(|message| message.into_text().ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(|value| value["type"] == "redeem");
        (carried_frame, socket_frame.or(later))
    });
    (port, served)
}
fn ready(stream: &PaneStream) {
    loop {
        match stream
            .events()
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
        {
            Event::Ready(_) => return,
            _ => continue,
        }
    }
}

#[test]
fn a_daemon_that_accepts_the_carried_redeem_gets_no_frame_on_the_socket() {
    let (port, served) = redeem_daemon(true);
    let (options, _) = options(port, true);
    let ticket = options.descriptor.redemption_ticket.clone();
    let stream = PaneStream::spawn(options).unwrap();
    ready(&stream);
    stream.cancel();
    let (carried, socket) = served.join().unwrap();
    assert_eq!(carried.unwrap()["ticket"], ticket);
    assert!(socket.is_none());
}

#[test]
fn a_daemon_that_does_not_echo_gets_the_frame_on_the_socket_as_before() {
    for (carry, echo) in [(true, false), (false, true)] {
        let (port, served) = redeem_daemon(echo);
        let (options, _) = options(port, carry);
        let ticket = options.descriptor.redemption_ticket.clone();
        let stream = PaneStream::spawn(options).unwrap();
        ready(&stream);
        stream.cancel();
        let (carried, socket) = served.join().unwrap();
        assert_eq!(carried.is_some(), carry);
        assert_eq!(socket.unwrap()["ticket"], ticket);
    }
}

/// review-460 (M9): a socket proven longer ago than the daemon is sure to
/// keep it is not used, even while it still looks open.
#[test]
fn a_prepared_socket_proven_too_long_ago_is_refused() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let prepared = PreparedSocket::spawn(port, peer(), Duration::from_secs(2));
    let (mut accepted, _) = listener.accept().unwrap();
    answer_identity(&mut accepted, &identity());
    thread::sleep(FRESH + Duration::from_millis(300));
    assert!(
        prepared
            .take(port, &peer(), Duration::from_secs(2))
            .is_none()
    );
    drop(accepted);
}
