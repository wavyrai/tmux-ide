use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui_apple::{
    surface_inbox::{SendStatus, SenderIdentity},
    surface_sender::Sender,
};
use herdr_client::{
    tmux_native_session::NativeSession,
    tmux_stream::{ConnectOptions, IssuedDescriptor, SUBPROTOCOL, ViewerMode},
};
use serde_json::{Value, json};
use std::{
    net::{TcpListener, TcpStream},
    sync::mpsc::sync_channel,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{
    Message, WebSocket,
    handshake::server::{Request, Response},
};
use uuid::Uuid;
const GENERATION: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const REQUEST: &str = "b987f903-e864-43dd-8591-8d0a464ca6e8";
const NONCE: &str = "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c";
const TRANSACTION: &str = "cc840bc1-d8af-4764-a586-c95befc44701";
const WAIT: Duration = Duration::from_secs(5);
fn send(socket: &mut WebSocket<TcpStream>, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .unwrap();
}
fn read(socket: &mut WebSocket<TcpStream>) -> Value {
    serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap()
}

#[test]
#[allow(clippy::result_large_err)] // tungstenite's handshake callback owns Response.
fn worker_imports_native_delivery_and_gpu_lease_wakes_original_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let options = ConnectOptions {
        remote_peer: None,
        descriptor: IssuedDescriptor {
            protocol_version: 2,
            web_socket_url: format!(
                "ws://127.0.0.1:{}/v2/terminal/pane-streams/redeem",
                listener.local_addr().unwrap().port()
            ),
            subprotocol: SUBPROTOCOL.into(),
            redemption_ticket: format!("ps2_{}", "a".repeat(43)),
            daemon_instance_id: GENERATION.into(),
            request_id: REQUEST.into(),
            expires_at: (SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
                + 30000) as u64,
            panes: vec!["pane.test".into()],
            effective_viewer_mode: ViewerMode::ReadOnly,
        },
        origin: "http://127.0.0.1:4000".into(),
        host_client_id: "native.test".into(),
    };
    let (retired_tx, retired_rx) = sync_channel(1);
    let (done_tx, done_rx) = sync_channel(1);
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let mut socket = tungstenite::accept_hdr(stream, |_: &Request, mut response: Response| {
            response
                .headers_mut()
                .insert("Sec-WebSocket-Protocol", SUBPROTOCOL.parse().unwrap());
            Ok(response)
        })
        .unwrap();
        assert_eq!(read(&mut socket)["type"], "redeem");
        send(
            &mut socket,
            json!({"type":"ready","protocolVersion":2,"daemonInstanceId":GENERATION,"requestId":REQUEST,"panes":["pane.test"],"effectiveViewerMode":"read-only"}),
        );
        send(
            &mut socket,
            json!({"type":"terminal-delivery-ready","pane":"pane.test","negotiation":{"accepted":true,"negotiated":{"protocolVersion":1,"encoding":"semantic-compact-v1","richPlacements":true,"generation":GENERATION,"deliveryNonce":NONCE}}}),
        );
        assert_eq!(read(&mut socket)["type"], "terminal-surface-watch");
        send(
            &mut socket,
            json!({"type":"terminal-surface-available","version":1,"generation":GENERATION,"connectionNonce":Uuid::new_v4()}),
        );
        let receiver = read(&mut socket);
        assert_eq!(receiver["type"], "terminal-surface-receiver");
        let peer = SenderIdentity::current().unwrap();
        send(
            &mut socket,
            json!({"type":"terminal-surface-peer","version":1,"generation":GENERATION,"connectionNonce":receiver["connectionNonce"],"auditToken":peer.token()}),
        );
        let now = Instant::now();
        let mut sender = Sender::new(
            std::process::id(),
            receiver["slot"].as_u64().unwrap() as u8,
            peer,
            *Uuid::parse_str(receiver["challenge"].as_str().unwrap())
                .unwrap()
                .as_bytes(),
            now + WAIT,
        )
        .unwrap();
        while !sender.poll(Instant::now()).unwrap() {
            assert!(now.elapsed() < WAIT);
            std::thread::sleep(Duration::from_millis(1));
        }
        let vectors: Value = serde_json::from_str(include_str!(
            "../../herdr-client/src/tmux_delivery/tests/vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        let wire = vector["wire"].as_str().unwrap();
        send(
            &mut socket,
            json!({"type":"terminal-delivery-envelope","pane":"pane.test","envelope":{
            "type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":"pane.test","generation":GENERATION,"incarnation":"pane:1","deliveryNonce":NONCE,"transactionId":TRANSACTION,
            "protocolVersion":1,"encoding":"semantic-compact-v1","frame":"seed","baseRevision":null,"canonicalRevision":1,"canonicalStateHash":vector["canonicalHash"],
            "representationHash":vector["representationHash"],"representationBytes":wire.len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true}}),
        );
        send(
            &mut socket,
            json!({"type":"terminal-delivery-chunk","pane":"pane.test","transactionId":TRANSACTION,"index":0,"data":STANDARD.encode(wire)}),
        );
        assert_eq!(read(&mut socket)["type"], "terminal-delivery-ack");
        let (source, _source_pool, _) = fixture();
        let surface = CVPixelBufferGetIOSurface(Some(&source.buffer.0)).unwrap();
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/native-surface-offers.json"
        ))
        .unwrap();
        let mut offer = vectors["cases"][0]["offer"].clone();
        offer["pane"] = json!("pane.test");
        offer["generation"] = json!(GENERATION);
        offer["incarnation"] = json!("pane:1");
        offer["deliveryNonce"] = json!(NONCE);
        offer["canonicalRevision"] = json!(1);
        offer["canonicalStateHash"] = vector["canonicalHash"].clone();
        offer["stride"] = json!(surface.bytes_per_row());
        offer["allocationBytes"] = json!(surface.alloc_size());
        let ticket = Uuid::parse_str(offer["storageTicket"].as_str().unwrap()).unwrap();
        send(&mut socket, offer);
        assert_eq!(
            sender
                .try_send(
                    &SurfacePort::from_surface(&surface).unwrap(),
                    *ticket.as_bytes(),
                    1
                )
                .unwrap(),
            SendStatus::Queued
        );
        // No further server control traffic wakes the worker. Only final storage
        // release can trigger this retirement after its handoff timer disarms.
        assert_eq!(
            read(&mut socket),
            json!({"type":"terminal-surface-retired","version":1,"sequence":1,"generation":receiver["generation"],"connectionNonce":receiver["connectionNonce"]})
        );
        retired_tx.send(()).unwrap();
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let (driver, inbox) = driver::Driver::new(Uuid::parse_str(GENERATION).unwrap());
    let session =
        NativeSession::spawn_with_surfaces(options, "workspace".into(), Box::new(driver)).unwrap();
    let start = Instant::now();
    let images = loop {
        if let Some(images) = inbox.drain().unwrap()
            && !images.is_empty()
        {
            break images;
        }
        assert!(
            start.elapsed() < WAIT,
            "native image not published: {:?}",
            session.drain().unwrap().status
        );
        std::thread::sleep(Duration::from_millis(1));
    };
    assert_eq!(images.len(), 1);
    assert!(retired_rx.try_recv().is_err());
    drop(images);
    retired_rx.recv_timeout(WAIT).unwrap();
    session.cancel();
    done_tx.send(()).unwrap();
    server.join().unwrap();
}
