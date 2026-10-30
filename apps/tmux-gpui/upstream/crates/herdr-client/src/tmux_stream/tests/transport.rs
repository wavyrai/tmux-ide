use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crossbeam_channel::bounded;
use tungstenite::{
    Message, WebSocket,
    handshake::server::{Request, Response},
};

use super::super::*;

const WAIT: Duration = Duration::from_secs(3);
const REQUEST: &str = "b987f903-e864-43dd-8591-8d0a464ca6e8";
const INSTANCE: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";

pub(super) fn options(port: u16) -> ConnectOptions {
    ConnectOptions {
        remote_peer: None,
        descriptor: IssuedDescriptor {
            protocol_version: 2,
            web_socket_url: format!("ws://127.0.0.1:{port}/v2/terminal/pane-streams/redeem"),
            subprotocol: SUBPROTOCOL.into(),
            redemption_ticket: format!("ps2_{}", "a".repeat(43)),
            daemon_instance_id: INSTANCE.into(),
            request_id: REQUEST.into(),
            expires_at: u64::try_from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap()
                + 30_000,
            panes: vec!["pane.one".into()],
            effective_viewer_mode: ViewerMode::Interactive,
        },
        origin: "http://127.0.0.1:4000".into(),
        host_client_id: "native.test".into(),
    }
}

pub(super) fn ready() -> String {
    serde_json::json!({"type":"ready","protocolVersion":2,"requestId":REQUEST,
        "daemonInstanceId":INSTANCE,"connectionClientId":"native.test","panes":["pane.one"],
        "effectiveViewerMode":"interactive", "inputLifetime":true})
    .to_string()
}

fn listener() -> TcpListener {
    TcpListener::bind("127.0.0.1:0").unwrap()
}

#[allow(clippy::result_large_err)] // tungstenite callback signature fixes the error type.
fn accept(listener: TcpListener) -> WebSocket<TcpStream> {
    let (stream, _) = listener.accept().unwrap();
    stream.set_read_timeout(Some(WAIT)).unwrap();
    stream.set_write_timeout(Some(WAIT)).unwrap();
    let mut socket =
        tungstenite::accept_hdr(stream, |request: &Request, mut response: Response| {
            assert_eq!(request.uri().path(), "/v2/terminal/pane-streams/redeem");
            assert_eq!(request.headers()["Origin"], "http://127.0.0.1:4000");
            assert_eq!(
                request.headers()["X-Tmux-Ide-Host-Client-Id"],
                "native.test"
            );
            assert_eq!(request.headers()["X-Tmux-Ide-Request-Id"], REQUEST);
            assert_eq!(request.headers()["Sec-WebSocket-Protocol"], SUBPROTOCOL);
            assert!(!request.headers().contains_key("Authorization"));
            assert!(!request.headers().contains_key("Cookie"));
            response
                .headers_mut()
                .insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
            Ok(response)
        })
        .unwrap();
    let redeem = socket.read().unwrap().into_text().unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&redeem).unwrap(),
        serde_json::json!({
            "type":"redeem","protocolVersion":2,"requestId":REQUEST,
            "daemonInstanceId":INSTANCE,"ticket":format!("ps2_{}", "a".repeat(43))
        })
    );
    socket
}

fn text(socket: &mut WebSocket<TcpStream>, value: String) {
    socket.send(Message::Text(value.into())).unwrap();
}

#[test]
fn exact_handshake_redeem_and_ordered_delivery() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let (finish_tx, finish_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        text(&mut socket, ready());
        text(&mut socket, r#"{"type":"terminal-delivery-ready","pane":"pane.one","negotiation":{"accepted":true}}"#.into());
        text(&mut socket, r#"{"type":"terminal-delivery-envelope","pane":"pane.one","envelope":{"semanticPaneId":"pane.one"}}"#.into());
        text(
            &mut socket,
            format!(
                r#"{{"type":"terminal-delivery-chunk","pane":"pane.one","transactionId":"{REQUEST}","index":0,"data":"e30="}}"#
            ),
        );
        assert_eq!(
            socket.read().unwrap().into_text().unwrap(),
            r#"{"type":"presence","generation":"g","state":"foreground"}"#
        );
        finish_tx.send(()).unwrap();
    });
    let client = PaneStream::spawn(options).unwrap();
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Ready(_)
    ));
    let next = client.events().recv_timeout(WAIT);
    assert!(
        matches!(next, Ok(Event::DeliveryReady { .. })),
        "{next:?} {:?}",
        client.completion().recv_timeout(WAIT)
    );
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Envelope { .. }
    ));
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Chunk { index: 0, .. }
    ));
    client
        .try_send(
            Command::from_json(
                r#"{"type":"presence","generation":"g","state":"foreground"}"#.into(),
            )
            .unwrap(),
        )
        .unwrap();
    finish_rx.recv_timeout(WAIT).unwrap();
    assert!(client.completion().recv_timeout(WAIT).is_ok());
    peer.join().unwrap();
}

#[test]
fn fragmented_frame_survives_timeouts_and_commands_wait() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let (partial_tx, partial_rx) = bounded(1);
    let (resume_tx, resume_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        text(&mut socket, ready());
        let body = br#"{"type":"authority-snapshot","snapshot":{}}"#;
        // Deliberately split the websocket header and payload across read timeouts.
        socket.get_mut().write_all(&[0x81]).unwrap();
        partial_tx.send(()).unwrap();
        resume_rx.recv_timeout(WAIT).unwrap();
        thread::sleep(Duration::from_millis(30));
        socket.get_mut().set_nonblocking(true).unwrap();
        let mut byte = [0];
        assert_eq!(
            socket.get_mut().read(&mut byte).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        socket.get_mut().set_nonblocking(false).unwrap();
        socket
            .get_mut()
            .write_all(&[u8::try_from(body.len()).unwrap()])
            .unwrap();
        socket.get_mut().write_all(&body[..7]).unwrap();
        thread::sleep(Duration::from_millis(30));
        socket.get_mut().write_all(&body[7..]).unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Text(_)));
    });
    let client = PaneStream::spawn(options).unwrap();
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Ready(_)
    ));
    partial_rx.recv_timeout(WAIT).unwrap();
    thread::sleep(Duration::from_millis(20));
    client
        .try_send(Command::from_json(r#"{"type":"presence"}"#.into()).unwrap())
        .unwrap();
    resume_tx.send(()).unwrap();
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Control(_)
    ));
    peer.join().unwrap();
}

#[test]
fn read_ahead_complete_then_partial_frame_fences_commands() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let (resume_tx, resume_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        text(&mut socket, ready());
        let body = br#"{"type":"authority-snapshot","snapshot":{}}"#;
        let length = u8::try_from(body.len()).unwrap();
        let mut combined = vec![0x81, length];
        combined.extend_from_slice(body);
        combined.extend_from_slice(&[0x81, length]);
        combined.extend_from_slice(&body[..7]);
        socket.get_mut().write_all(&combined).unwrap();
        resume_rx.recv_timeout(WAIT).unwrap();
        thread::sleep(Duration::from_millis(30));
        socket.get_mut().set_nonblocking(true).unwrap();
        let mut byte = [0];
        assert_eq!(
            socket.get_mut().read(&mut byte).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        socket.get_mut().set_nonblocking(false).unwrap();
        socket.get_mut().write_all(&body[7..]).unwrap();
        assert!(matches!(socket.read().unwrap(), Message::Text(_)));
    });
    let client = PaneStream::spawn(options).unwrap();
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Ready(_)
    ));
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Control(_)
    ));
    client
        .try_send(Command::from_json(r#"{"type":"presence"}"#.into()).unwrap())
        .unwrap();
    resume_tx.send(()).unwrap();
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Control(_)
    ));
    peer.join().unwrap();
}

#[test]
fn cancellation_closes_owned_socket_without_queued_commands() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let (redeemed_tx, redeemed_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        redeemed_tx.send(()).unwrap();
        // No ready: caller commands must remain queued, cancellation must not flush them.
        assert!(socket.read().is_err());
    });
    let client = PaneStream::spawn(options).unwrap();
    redeemed_rx.recv_timeout(WAIT).unwrap();
    client
        .try_send(Command::from_json(r#"{"type":"presence"}"#.into()).unwrap())
        .unwrap();
    client.cancel();
    assert!(client.completion().recv_timeout(WAIT).is_ok());
    assert!(matches!(
        client.try_send(Command::from_json(r#"{"type":"presence"}"#.into()).unwrap()),
        Err(Error::Cancelled)
    ));
    peer.join().unwrap();
}

#[test]
fn cancellation_while_backpressured_is_not_lost_in_the_full_event_queue() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        text(&mut socket, ready());
        for _ in 0..12 {
            if socket
                .send(Message::Text(
                    r#"{"type":"authority-snapshot","snapshot":{}}"#.into(),
                ))
                .is_err()
            {
                break;
            }
        }
        let _ = socket.read();
    });
    let client = PaneStream::spawn(options).unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while client.events().len() < 8 {
        assert!(std::time::Instant::now() < deadline);
        thread::yield_now();
    }
    client.cancel();
    assert!(matches!(
        client.completion().recv_timeout(WAIT).unwrap(),
        Error::Cancelled
    ));
    assert_eq!(client.events().len(), 8);
    peer.join().unwrap();
}

#[test]
fn wrong_ready_identity_is_rejected_before_delivery() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        text(
            &mut socket,
            ready().replace("native.test", "another.client"),
        );
        let _ = socket.read();
    });
    let client = PaneStream::spawn(options).unwrap();
    assert!(matches!(
        client.completion().recv_timeout(WAIT).unwrap(),
        Error::Identity
    ));
    assert!(client.events().is_empty());
    peer.join().unwrap();
}

#[test]
fn descriptors_are_loopback_only_and_debug_redacts_ticket() {
    let mut options = options(12345);
    assert!(options.descriptor.validate().is_ok());
    assert!(!format!("{:?}", options.descriptor).contains("ps2_"));
    for url in [
        "ws://example.com:12345/v2/terminal/pane-streams/redeem",
        "ws://127.0.0.1:12345/other",
        "ws://user:pass@127.0.0.1:12345/v2/terminal/pane-streams/redeem",
        "ws://127.0.0.1:12345/v2/terminal/pane-streams/redeem?token=x",
    ] {
        options.descriptor.web_socket_url = url.into();
        assert!(matches!(
            options.descriptor.validate(),
            Err(Error::Descriptor)
        ));
    }
}

#[test]
fn input_and_remote_errors_are_bounded_and_redacted() {
    assert!(matches!(
        Command::from_json("x".repeat(MAX_CLIENT_BYTES + 1)),
        Err(Error::FrameBound)
    ));
    assert!(matches!(
        Command::from_json(r#"{"type":"redeem"}"#.into()),
        Err(Error::Frame)
    ));
    let error = wire::parse(
        r#"{"type":"secret-terminal-content"}"#,
        &options(12345),
        true,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "unexpected pane-stream frame");
    let error = wire::parse(&"x".repeat(MAX_SERVER_BYTES + 1), &options(12345), true).unwrap_err();
    assert!(matches!(error, Error::FrameBound));
    let response = tungstenite::http::Response::builder()
        .status(403)
        .body(Some(b"ps2_secret-reflected-ticket".to_vec()))
        .unwrap();
    let error = Error::from(tungstenite::Error::Http(Box::new(response)));
    assert_eq!(format!("{error:?}"), "pane-stream websocket failed");
    assert!(std::error::Error::source(&error).is_some());
}

#[test]
fn missing_negotiated_subprotocol_rejects_before_redemption() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let peer = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let mut socket = tungstenite::accept(stream).unwrap();
        assert!(socket.read().is_err());
    });
    let client = PaneStream::spawn(options).unwrap();
    assert!(client.completion().recv_timeout(WAIT).is_ok());
    assert!(client.events().is_empty());
    peer.join().unwrap();
}

#[test]
fn oversized_websocket_frame_is_rejected_before_payload_allocation() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        text(&mut socket, ready());
        let mut header = vec![0x81, 127];
        header.extend_from_slice(&(MAX_SERVER_BYTES as u64 + 1).to_be_bytes());
        socket.get_mut().write_all(&header).unwrap();
        assert!(socket.read().is_err());
    });
    let client = PaneStream::spawn(options).unwrap();
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Ready(_)
    ));
    assert!(matches!(
        client.completion().recv_timeout(WAIT).unwrap(),
        Error::WebSocket(_)
    ));
    peer.join().unwrap();
}

#[test]
fn full_sixteen_mib_seed_burst_survives_a_paused_then_slow_consumer() {
    let listener = listener();
    let options = options(listener.local_addr().unwrap().port());
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        text(&mut socket, ready());
        let data = "A".repeat((256 * 1024_usize).div_ceil(3) * 4);
        for index in 0..64 {
            text(
                &mut socket,
                serde_json::json!({"type":"terminal-delivery-chunk",
                "pane":"pane.one", "transactionId":REQUEST, "index":index, "data":data})
                .to_string(),
            );
        }
        // Keep the physical connection alive until the consumer confirms the final chunk.
        assert!(matches!(socket.read().unwrap(), Message::Text(_)));
    });
    let client = PaneStream::spawn(options).unwrap();
    thread::sleep(Duration::from_millis(75));
    assert!(client.completion().is_empty());
    assert!(matches!(
        client.events().recv_timeout(WAIT).unwrap(),
        Event::Ready(_)
    ));
    for expected in 0..64 {
        match client.events().recv_timeout(WAIT).unwrap() {
            Event::Chunk { index, data, .. } => {
                assert_eq!(index, expected);
                assert_eq!(data.len(), (256 * 1024_usize).div_ceil(3) * 4);
            }
            unexpected => panic!("unexpected event {unexpected:?}"),
        }
        thread::sleep(Duration::from_millis(2));
    }
    client
        .try_send(Command::from_json(r#"{"type":"presence"}"#.into()).unwrap())
        .unwrap();
    peer.join().unwrap();
}

#[test]
fn interactive_readiness_requires_connection_identity_and_input_lifetime() {
    let options = options(12345);
    let mut frame: serde_json::Value = serde_json::from_str(&ready()).unwrap();
    frame.as_object_mut().unwrap().remove("connectionClientId");
    assert!(matches!(
        wire::parse(&frame.to_string(), &options, false),
        Err(Error::Identity)
    ));
    frame["inputLifetime"] = false.into();
    frame["connectionClientId"] = "native.test".into();
    assert!(matches!(
        wire::parse(&frame.to_string(), &options, false),
        Err(Error::Identity)
    ));
    frame.as_object_mut().unwrap().remove("inputLifetime");
    frame["requestId"] = "c987f903-e864-43dd-8591-8d0a464ca6e8".into();
    assert!(matches!(
        wire::parse(&frame.to_string(), &options, false),
        Err(Error::Identity)
    ));
    let mut options = options;
    options.descriptor.effective_viewer_mode = ViewerMode::ReadOnly;
    let mut frame: serde_json::Value = serde_json::from_str(&ready()).unwrap();
    frame.as_object_mut().unwrap().remove("connectionClientId");
    frame.as_object_mut().unwrap().remove("inputLifetime");
    frame["effectiveViewerMode"] = "read-only".into();
    assert!(matches!(
        wire::parse(&frame.to_string(), &options, false),
        Ok(Event::Ready(_))
    ));
}

#[test]
fn interactive_ready_from_a_2_9_7_daemon_is_too_old_not_an_identity_mismatch() {
    // v2.9.7 pane-stream-websocket.ts sends exactly these fields.
    let frame = serde_json::json!({"type":"ready","protocolVersion":2,"daemonInstanceId":INSTANCE,
        "requestId":REQUEST,"connectionClientId":"native.test","panes":["pane.one"],
        "effectiveViewerMode":"interactive"});
    assert!(matches!(
        wire::parse(&frame.to_string(), &options(12345), false),
        Err(Error::DaemonTooOld)
    ));
}

#[test]
fn byte_capability_is_optional_true_only() {
    let options = options(12345);
    let mut frame: serde_json::Value = serde_json::from_str(&ready()).unwrap();
    match wire::parse(&frame.to_string(), &options, false).unwrap() {
        Event::Ready(ready) => assert_eq!(ready.input_bytes, None),
        _ => panic!("expected ready"),
    }
    frame["inputBytes"] = true.into();
    match wire::parse(&frame.to_string(), &options, false).unwrap() {
        Event::Ready(ready) => assert_eq!(ready.input_bytes, Some(true)),
        _ => panic!("expected ready"),
    }
    frame["inputBytes"] = false.into();
    assert!(wire::parse(&frame.to_string(), &options, false).is_err());
}
