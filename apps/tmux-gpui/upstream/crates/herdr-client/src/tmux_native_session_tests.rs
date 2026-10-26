#![allow(clippy::unwrap_used)]
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use crossbeam_channel::bounded;
use serde_json::{Value, json, value::to_raw_value};
use std::{
    net::{TcpListener, TcpStream},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{
    Message, WebSocket,
    handshake::server::{Request, Response},
};

const WAIT: Duration = Duration::from_secs(3);
const INSTANCE: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const REQUEST: &str = "b987f903-e864-43dd-8591-8d0a464ca6e8";
const NONCE: &str = "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c";
const TRANSACTION: &str = "cc840bc1-d8af-4764-a586-c95befc44701";

fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!("tmux_delivery/tests/vectors.json")).unwrap()
}

fn fixture() -> (TcpListener, ConnectOptions) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let descriptor = tmux_stream::IssuedDescriptor {
        protocol_version: 2,
        web_socket_url: format!(
            "ws://127.0.0.1:{}/v2/terminal/pane-streams/redeem",
            listener.local_addr().unwrap().port()
        ),
        subprotocol: tmux_stream::SUBPROTOCOL.into(),
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
        panes: vec!["pane.test".into()],
        effective_viewer_mode: tmux_stream::ViewerMode::ReadOnly,
    };
    (
        listener,
        ConnectOptions {
            remote_peer: None,
            descriptor,
            origin: "http://127.0.0.1:4000".into(),
            host_client_id: "native.test".into(),
        },
    )
}

fn accept(listener: TcpListener) -> WebSocket<TcpStream> {
    accept_encoding(listener, "semantic-compact-v1")
}
fn accept_encoding(listener: TcpListener, encoding: &str) -> WebSocket<TcpStream> {
    accept_offered(listener, encoding, false)
}
#[allow(clippy::result_large_err)] // tungstenite fixes this callback's error type.
fn accept_offered(listener: TcpListener, encoding: &str, projection: bool) -> WebSocket<TcpStream> {
    let (stream, _) = listener.accept().unwrap();
    stream.set_read_timeout(Some(WAIT)).unwrap();
    let mut socket =
        tungstenite::accept_hdr(stream, |_request: &Request, mut response: Response| {
            response.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                tmux_stream::SUBPROTOCOL.parse().unwrap(),
            );
            Ok(response)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&socket.read().unwrap().into_text().unwrap()).unwrap()["type"],
        "redeem"
    );
    send(
        &mut socket,
        json!({"type":"ready","protocolVersion":2,"daemonInstanceId":INSTANCE,
        "requestId":REQUEST,"panes":["pane.test"],"effectiveViewerMode":"read-only"}),
    );
    send(
        &mut socket,
        json!({"type":"terminal-delivery-ready","pane":"pane.test","negotiation":{"accepted":true,
        "negotiated":{"protocolVersion":1,"encoding":encoding,"richPlacements":true,
        "generation":INSTANCE,"deliveryNonce":NONCE,"alternateScreenProjection":if projection {Some("deferred-history-v1")} else {None}}}}),
    );
    socket
}

fn send(socket: &mut WebSocket<TcpStream>, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .unwrap();
}

fn transaction(socket: &mut WebSocket<TcpStream>, index: usize, corrupt: bool) {
    let vector = &vectors()[index];
    let wire = vector["wire"].as_str().unwrap();
    send(
        socket,
        json!({"type":"terminal-delivery-envelope","pane":"pane.test","envelope":{
        "type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":"pane.test",
        "generation":INSTANCE,"incarnation":"pane:1","deliveryNonce":NONCE,"transactionId":TRANSACTION,
        "protocolVersion":1,"encoding":"semantic-compact-v1","frame":if index==0 {"seed"}else{"patch"},
        "baseRevision":if index==0 {Value::Null}else{json!(1)},"canonicalRevision":index+1,
        "canonicalStateHash":if corrupt {json!("0000000000000000")}else{vector["canonicalHash"].clone()},
        "representationHash":vector["representationHash"],"representationBytes":wire.len(),"chunkCount":1,
        "canonicalEquivalent":true,"history":"complete","richPlacements":true}}),
    );
    send(
        socket,
        json!({"type":"terminal-delivery-chunk","pane":"pane.test","transactionId":TRANSACTION,
        "index":0,"data":STANDARD.encode(wire)}),
    );
}

fn ack(socket: &mut WebSocket<TcpStream>, index: usize) {
    let frame: Value = serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
    assert_eq!(frame["type"], "terminal-delivery-ack");
    assert_eq!(frame["ack"]["canonicalRevision"], index + 1);
    assert_eq!(
        frame["ack"]["canonicalStateHash"],
        vectors()[index]["canonicalHash"]
    );
}

fn until<T>(mut read: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(value) = read() {
            return value;
        }
        assert!(Instant::now() < deadline, "condition did not become true");
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn commits_acknowledge_off_ui_and_coalesced_deltas_keep_the_latest_baseline() {
    let (listener, options) = fixture();
    let (seed_tx, seed_rx) = bounded(1);
    let (patch_tx, patch_rx) = bounded(1);
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        seed_tx.send(()).unwrap();
        patch_rx.recv_timeout(WAIT).unwrap();
        transaction(&mut socket, 1, false);
        ack(&mut socket, 1);
        done_rx.recv_timeout(WAIT).unwrap();
        send(&mut socket, json!({"type":"terminal-delivery-fault"}));
        let _ = socket.read();
    });
    let session = NativeSession::spawn(options, "workspace".into()).unwrap();
    seed_rx.recv_timeout(WAIT).unwrap();
    let seed = until(|| session.snapshot("pane.test").unwrap());
    patch_tx.send(()).unwrap();
    let latest = until(|| {
        session
            .snapshot("pane.test")
            .unwrap()
            .filter(|snapshot| !Arc::ptr_eq(snapshot, &seed))
    });
    assert!(Arc::ptr_eq(&seed.grid[0], &latest.grid[0]));
    assert!(!Arc::ptr_eq(&seed.grid[1], &latest.grid[1]));
    // No UI drain was needed to retain the baseline or ACK either transaction.
    let updates = session.drain().unwrap();
    assert!(matches!(updates.status, Status::Ready(_)));
    assert_eq!(updates.panes.len(), 1);
    let identity = &updates.panes["pane.test"].identity;
    assert_eq!(identity.generation, INSTANCE);
    assert_eq!(identity.incarnation, "pane:1");
    assert_eq!(identity.delivery_nonce, NONCE);
    assert_eq!(identity.canonical_revision, 2);
    assert_eq!(
        identity.canonical_state_hash,
        vectors()[1]["canonicalHash"].as_str().unwrap()
    );
    assert!(Arc::ptr_eq(
        identity,
        &session.committed("pane.test").unwrap().unwrap().identity
    ));
    assert_eq!(updates.panes["pane.test"].changed_rows, vec![0, 1]);
    assert!(Arc::ptr_eq(
        updates.panes["pane.test"].snapshot.as_ref().unwrap(),
        &latest
    ));
    assert!(session.drain().unwrap().panes.is_empty());
    done_tx.send(()).unwrap();
    until(|| matches!(session.drain().unwrap().status, Status::Failed(_)).then_some(()));
    assert!(session.snapshot("pane.test").unwrap().is_none());
    assert!(session.committed("pane.test").unwrap().is_none());
    assert!(session.drain().unwrap().panes.is_empty());
    peer.join().unwrap();
}

#[test]
fn rejected_commit_never_acknowledges_and_clears_current_state() {
    let (listener, options) = fixture();
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, true);
        assert!(socket.read().is_err());
    });
    let session = NativeSession::spawn(options, "workspace".into()).unwrap();
    until(|| matches!(session.drain().unwrap().status, Status::Failed(_)).then_some(()));
    assert!(session.snapshot("pane.test").unwrap().is_none());
    assert!(session.committed("pane.test").unwrap().is_none());
    peer.join().unwrap();
}

#[test]
fn cancellation_clears_actionable_state_and_rejects_delayed_publication() {
    let (listener, options) = fixture();
    let (seed_tx, seed_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        seed_tx.send(()).unwrap();
        assert!(socket.read().is_err());
    });
    let session = NativeSession::spawn(options, "workspace".into()).unwrap();
    seed_rx.recv_timeout(WAIT).unwrap();
    let _preview = until(|| session.snapshot("pane.test").unwrap());
    session.cancel();
    assert!(session.snapshot("pane.test").unwrap().is_none());
    assert!(session.committed("pane.test").unwrap().is_none());
    assert!(matches!(session.drain().unwrap().status, Status::Cancelled));
    assert!(matches!(
        publish(
            &session.shared,
            Outcome::Control(to_raw_value(&json!({"type":"layout"})).unwrap())
        ),
        Err(Error::Cancelled)
    ));
    assert!(session.drain().unwrap().controls.is_empty());
    peer.join().unwrap();
    // No deadline or new data is needed: socket shutdown wakes completion and releases the model.
    until(|| (Arc::strong_count(&session.shared) == 1).then_some(()));
}

#[test]
fn coalesced_resize_discards_rows_outside_new_height_and_tombstone_clears_them() {
    let mut store = crate::tmux_delivery::Store::default();
    let vector = &vectors()[0];
    let applied = store
        .apply(
            crate::tmux_delivery::decode_compact(vector["wire"].as_str().unwrap().as_bytes())
                .unwrap(),
            vector["canonicalHash"].as_str().unwrap(),
        )
        .unwrap();
    let snapshot = store.snapshot().unwrap().clone();
    let mut mailbox = Mailbox::new();
    let committed = |snapshot| {
        Arc::new(CommittedPane {
            snapshot,
            identity: Arc::new(CommittedIdentity {
                generation: INSTANCE.into(),
                incarnation: "pane:1".into(),
                delivery_nonce: NONCE.into(),
                canonical_revision: 1,
                canonical_state_hash: "0000000000000000".into(),
            }),
        })
    };
    mailbox.commit(
        "pane.test".into(),
        committed(Some(snapshot.clone())),
        applied.changed_rows,
    );
    let mut smaller = (*snapshot).clone();
    smaller.grid.truncate(1);
    smaller.rows = 1;
    mailbox.commit(
        "pane.test".into(),
        committed(Some(Arc::new(smaller))),
        vec![0],
    );
    assert_eq!(mailbox.pending["pane.test"].rows, BTreeSet::from([0]));
    mailbox.commit("pane.test".into(), committed(None), vec![]);
    assert!(mailbox.pending["pane.test"].rows.is_empty());
    assert!(mailbox.current["pane.test"].snapshot.is_none());
}

#[test]
fn controls_remain_ordered_with_count_and_aggregate_byte_bounds() {
    let shared = Mutex::new(Mailbox::new());
    for index in 0..CONTROL_COUNT {
        publish(
            &shared,
            Outcome::Control(to_raw_value(&json!({"index":index})).unwrap()),
        )
        .unwrap();
    }
    assert!(matches!(
        publish(&shared, Outcome::Control(to_raw_value(&json!({})).unwrap())),
        Err(Error::ControlBacklog)
    ));
    for (index, frame) in shared.lock().unwrap().controls.iter().enumerate() {
        assert_eq!(
            serde_json::from_str::<Value>(frame.get()).unwrap()["index"],
            index
        );
    }
    let shared = Mutex::new(Mailbox::new());
    let raw = to_raw_value(&"x".repeat(CONTROL_BYTES)).unwrap();
    assert!(matches!(
        publish(&shared, Outcome::Control(raw)),
        Err(Error::ControlBacklog)
    ));
    assert!(shared.lock().unwrap().controls.is_empty());
}

fn graphics_state() -> Value {
    let vectors: Value =
        serde_json::from_str(include_str!("tmux_graphics/tests/vectors.json")).unwrap();
    let mut state = vectors["cases"][0]["state"].clone();
    let digest = state["images"][0]["digest"].clone();
    state["placements"] = json!([{"digest":digest,"row":0,"column":0,"rows":1,"columns":1,"sourceRow":0,"sourceColumn":0,"totalRows":4,"totalColumns":4}]);
    state
}

#[test]
fn graphics_worker_requests_and_verifies_chunks_without_raw_control_backlog() {
    let (listener, options) = fixture();
    let (sent_tx, sent_rx) = bounded(1);
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        let state = graphics_state();
        send(
            &mut socket,
            json!({"type":"terminal-graphics","pane":"pane.test","state":state}),
        );
        let request: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(request["type"], "terminal-graphics-request");
        assert_eq!(request["pane"], "pane.test");
        let image = &state["images"][0];
        for offset in [0, 32] {
            let data = (offset..offset + 32).map(|v| v as u8).collect::<Vec<_>>();
            send(
                &mut socket,
                json!({"type":"terminal-graphics-blob","pane":"pane.test","blob":{
                "digest":image["digest"],"format":"rgba","width":4,"height":4,"total":64,"offset":offset},"data":STANDARD.encode(data)}),
            );
        }
        sent_tx.send(()).unwrap();
        let retry: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(retry["type"], "terminal-graphics-request");
        assert_eq!(retry["digests"], request["digests"]);
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let session = NativeSession::spawn_with_graphics(options, "workspace".into()).unwrap();
    sent_rx.recv_timeout(WAIT).unwrap();
    until(|| (session.shared.lock().unwrap().graphics.len() == 2).then_some(()));
    let updates = session.drain().unwrap();
    assert!(updates.controls.is_empty());
    assert!(updates.cell_pixels && updates.precise_cell_pixels);
    assert_eq!(updates.graphics_placements["pane.test"].placements.len(), 1);
    let placement_identity = &updates.graphics_placements["pane.test"].identity;
    assert!(Arc::ptr_eq(
        placement_identity,
        &updates.panes["pane.test"].identity
    ));
    assert!(Arc::ptr_eq(
        placement_identity,
        &session.committed("pane.test").unwrap().unwrap().identity,
    ));
    assert_eq!(
        updates.graphics_placements["pane.test"]
            .identity
            .canonical_revision,
        1
    );
    let flags = updates
        .graphics
        .iter()
        .map(|event| match event {
            GraphicsEvent::Chunk(chunk) => chunk.complete_verified,
            _ => panic!("chunk expected"),
        })
        .collect::<Vec<_>>();
    assert_eq!(flags, vec![false, true]);
    session
        .graphics_missing(vec![
            graphics_state()["images"][0]["digest"]
                .as_str()
                .unwrap()
                .into(),
        ])
        .unwrap();
    until(|| (!session.shared.lock().unwrap().graphics.is_empty()).then_some(()));
    assert!(matches!(
        session.drain().unwrap().graphics[0],
        GraphicsEvent::Invalidate(_)
    ));
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}

#[test]
fn unoffered_graphics_fails_closed_and_retires_current_snapshots() {
    let (listener, options) = fixture();
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        send(
            &mut socket,
            json!({"type":"terminal-graphics","pane":"pane.test","state":graphics_state()}),
        );
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let session = NativeSession::spawn(options, "workspace".into()).unwrap();
    until(|| matches!(session.drain().unwrap().status, Status::Failed(_)).then_some(()));
    assert!(session.snapshot("pane.test").unwrap().is_none());
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}

#[test]
fn saturated_graphics_mailbox_fails_closed_without_dropping_invalidations() {
    let mut mailbox = Mailbox::new();
    for _ in 0..GRAPHICS_COUNT {
        mailbox
            .graphics_event(GraphicsEvent::Invalidate(vec!["a".repeat(32)]))
            .unwrap();
    }
    assert!(matches!(
        mailbox.graphics_event(GraphicsEvent::Invalidate(vec!["b".repeat(32)])),
        Err(Error::GraphicsBacklog)
    ));
    assert_eq!(mailbox.graphics.len(), GRAPHICS_COUNT);
    mailbox.retire(Status::Failed(Arc::new(Error::GraphicsBacklog)));
    assert!(mailbox.graphics.is_empty());
    assert_eq!(mailbox.graphics_bytes, 0);
    assert!(matches!(
        mailbox.graphics_event(GraphicsEvent::Invalidate(vec![])),
        Err(Error::Cancelled)
    ));
}

#[test]
fn framed_graphics_saturation_retires_partial_images_and_canonical_state() {
    let (listener, options) = fixture();
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        let state = graphics_state();
        send(
            &mut socket,
            json!({"type":"terminal-graphics","pane":"pane.test","state":state}),
        );
        let _request = socket.read().unwrap();
        for offset in 0..33 {
            send(
                &mut socket,
                json!({"type":"terminal-graphics-blob","pane":"pane.test","blob":{
                "digest":state["images"][0]["digest"],"format":"rgba","width":4,"height":4,"total":64,"offset":offset},"data":STANDARD.encode([offset as u8])}),
            );
        }
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let session = NativeSession::spawn_with_graphics(options, "workspace".into()).unwrap();
    until(|| matches!(session.shared.lock().unwrap().status, Status::Failed(_)).then_some(()));
    let updates = session.drain().unwrap();
    assert!(
        matches!(updates.status,Status::Failed(error) if matches!(*error,Error::GraphicsBacklog))
    );
    assert!(updates.graphics.is_empty() && updates.graphics_placements.is_empty());
    assert!(session.snapshot("pane.test").unwrap().is_none());
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}

#[cfg(unix)]
#[path = "tmux_native_session_local_tests.rs"]
mod local_tests;

#[test]
fn maintenance_reuses_an_armed_receiver_and_has_no_idle_timer() {
    let mut maintenance = Maintenance::new();
    assert!(maintenance.deadline.is_none());
    assert!(maintenance.receiver.try_recv().is_err());
    let deadline = Instant::now() + Duration::from_secs(60);
    maintenance.arm(Some(deadline));
    let original = maintenance.receiver.clone();
    for _ in 0..100 {
        maintenance.arm(Some(deadline));
        assert!(original.same_channel(&maintenance.receiver));
    }
    maintenance.arm(None);
    assert!(maintenance.deadline.is_none());
    assert!(maintenance.receiver.try_recv().is_err());
}

#[test]
fn graphics_expiry_runs_while_model_event_channel_remains_busy() {
    let (listener, options) = fixture();
    let (started_tx, started_rx) = bounded(1);
    let (retry_tx, retry_rx) = bounded(1);
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        send(
            &mut socket,
            json!({"type":"terminal-graphics","pane":"pane.test","state":graphics_state()}),
        );
        let first: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(first["type"], "terminal-graphics-request");
        started_tx.send(()).unwrap();
        socket
            .get_ref()
            .set_read_timeout(Some(Duration::from_secs(6)))
            .unwrap();
        let retry: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(retry, first);
        retry_tx.send(()).unwrap();
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let session = NativeSession::spawn_with_graphics(options, "workspace".into()).unwrap();
    started_rx.recv_timeout(WAIT).unwrap();
    // Keep one real model input queue ready. Empty notices neither invalidate the image
    // nor reset its timeout, but formerly prevented select!'s idle default from running.
    let notices = session.graphics_missing.clone();
    let producer = thread::spawn(move || {
        let mut sent = 0;
        while notices
            .send_timeout(Vec::new(), Duration::from_millis(100))
            .is_ok()
        {
            sent += 1;
        }
        sent
    });
    retry_rx.recv_timeout(Duration::from_secs(6)).unwrap();
    session.cancel();
    assert!(producer.join().unwrap() > 100);
    done_tx.send(()).unwrap();
    peer.join().unwrap();
    until(|| (Arc::strong_count(&session.shared) == 1).then_some(()));
}

#[path = "tmux_native_session_binary_tests.rs"]
mod binary;

#[path = "tmux_native_session_projection_tests.rs"]
mod projection;

#[path = "tmux_native_session_completion_tests.rs"]
mod completion;

#[path = "tmux_native_session_surface_tests.rs"]
mod native_surfaces;

#[cfg(unix)]
#[path = "tmux_native_session_backpressure_tests.rs"]
mod backpressure_tests;
