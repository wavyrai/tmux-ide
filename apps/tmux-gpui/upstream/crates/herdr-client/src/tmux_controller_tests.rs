#![allow(clippy::unwrap_used)]
use super::*;
use crate::{
    tmux_delivery::{Store, decode_compact},
    tmux_native_session::CommittedIdentity,
};
use serde_json::Value;
use std::{
    net::TcpListener,
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const GEN: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const OP: &str = "b987f903-e864-43dd-8591-8d0a464ca6e8";
const TOKEN: &str = "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c";
fn authority() -> Value {
    json!({"generation":GEN,"session":"session","revision":1,"owners":{"input":"native.test","focus":null,"geometry":null},"nativeGeometryYieldUntilMs":0,"clients":[]})
}
fn populate(controller: &mut Controller) {
    controller.policy.ready(Some("native.test"), true).unwrap();
    controller.ready = true;
    controller.policy.presence(true, OP, TOKEN, 0).unwrap();
    controller.policy.accept_json(&serde_json::to_vec(&json!({"type":"authority-receipt","requestId":OP,"authority":"input","status":"granted","lease":{"generation":GEN,"session":"session","clientId":"native.test","authority":"input","token":TOKEN,"revision":1},"snapshot":authority()})).unwrap()).unwrap();
    let vectors: Vec<Value> =
        serde_json::from_str(include_str!("tmux_delivery/tests/vectors.json")).unwrap();
    let mut store = Store::default();
    store
        .apply(
            decode_compact(vectors[0]["wire"].as_str().unwrap().as_bytes()).unwrap(),
            vectors[0]["canonicalHash"].as_str().unwrap(),
        )
        .unwrap();
    for pane in ["left", "right"] {
        let lifetime = Lifetime {
            generation: GEN.into(),
            incarnation: format!("birth-{pane}"),
        };
        controller
            .policy
            .bind_lifetime(pane, Some(lifetime.clone()))
            .unwrap();
        controller.current.insert(
            pane.into(),
            Arc::new(CommittedPane {
                snapshot: store.snapshot().cloned(),
                identity: Arc::new(CommittedIdentity {
                    generation: GEN.into(),
                    incarnation: lifetime.incarnation,
                    delivery_nonce: TOKEN.into(),
                    canonical_revision: 1,
                    canonical_state_hash: vectors[0]["canonicalHash"].as_str().unwrap().into(),
                }),
            }),
        );
    }
    controller.topology.apply_control(&serde_json::value::to_raw_value(&json!({"type":"layout","semanticWindowId":"window.one","windowName":"Window","currentWindow":true,"cols":9,"rows":2,"zoomed":false,"paneBorderStatus":"off","modeKeys":null,"panes":[{"pane":"left","left":0,"top":0,"width":4,"height":2,"active":true},{"pane":"right","left":5,"top":0,"width":4,"height":2,"active":false}]})).unwrap()).unwrap();
    controller.cached_window = controller
        .presentation
        .update(&controller.topology, &controller.current, true)
        .unwrap();
    controller.actionable = true;
}
fn fixture() -> (
    Controller,
    mpsc::Receiver<Value>,
    mpsc::Sender<Value>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (observed_tx, observed) = mpsc::channel();
    let (response, response_rx) = mpsc::channel::<Value>();
    let peer = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        #[allow(clippy::result_large_err)]
        let mut socket = tungstenite::accept_hdr(
            stream,
            |_request: &tungstenite::handshake::server::Request,
             mut response: tungstenite::handshake::server::Response| {
                response.headers_mut().insert(
                    "Sec-WebSocket-Protocol",
                    tmux_stream::SUBPROTOCOL.parse().unwrap(),
                );
                Ok(response)
            },
        )
        .unwrap();
        let _redeem = socket.read().unwrap();
        socket.send(tungstenite::Message::Text(json!({"type":"ready","protocolVersion":2,"daemonInstanceId":GEN,"requestId":OP,"panes":["left","right"],"effectiveViewerMode":"interactive","connectionClientId":"native.test","inputLifetime":true,"authority":authority()}).to_string().into())).unwrap();
        while let Ok(message) = socket.read() {
            if let tungstenite::Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).unwrap();
                observed_tx.send(value).unwrap();
                if let Ok(response) = response_rx.recv_timeout(Duration::from_secs(3)) {
                    if socket
                        .send(tungstenite::Message::Text(response.to_string().into()))
                        .is_err()
                    {
                        break;
                    }
                } else {
                    break;
                }
            } else if message.is_close() {
                break;
            }
        }
    });
    let handoff = Handoff::parse(&serde_json::to_vec(&json!({"descriptor":{"protocolVersion":2,"webSocketUrl":format!("ws://127.0.0.1:{port}/v2/terminal/pane-streams/redeem"),"subprotocol":tmux_stream::SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":GEN,"requestId":OP,"expiresAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64+30000,"panes":["left","right"],"effectiveViewerMode":"interactive"},"origin":"http://127.0.0.1:4000","hostClientId":"native.test","workspaceName":"workspace","selectedPane":"left"})).unwrap()).unwrap();
    let mut controller = Controller::spawn(handoff).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let state = controller.session.drain().unwrap();
        if matches!(state.status, Status::Ready(_)) {
            break;
        }
        if let Status::Failed(error) = state.status {
            panic!("{error}");
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(1));
    }
    populate(&mut controller);
    (controller, observed, response, peer)
}
fn receipt() -> Value {
    json!({"type":"semantic-intent-ack","operationId":OP,"outcome":{"status":"applied","result":{"verb":"workspace.pane.select","operationId":OP,"daemonInstanceId":GEN,"workspaceName":"workspace","outcome":"applied","semanticPaneId":"right"}}})
}
fn settle(controller: &mut Controller) -> SelectionCompletion {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(completion) = controller.poll(1).unwrap().selection {
            return completion;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn same_window_selection_uses_existing_socket_and_no_geometry() {
    let (mut c, observed, response, peer) = fixture();
    let lifetime = c.selectable("right").unwrap();
    assert!(c.select_pane("right", &lifetime, OP, 0).unwrap());
    assert_eq!(c.selected(), "left");
    assert!(!c.owns(Authority::Input));
    let wire = observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(wire["type"], "semantic-intent");
    assert_eq!(wire["intent"]["semanticPaneId"], "right");
    assert_eq!(wire["intent"]["verb"], "workspace.pane.select");
    response.send(receipt()).unwrap();
    assert!(settle(&mut c).selected);
    assert_eq!(c.selected(), "right");
    assert!(c.viewport.is_none());
    assert!(c.inflight_viewport.is_none());
    assert!(!c.geometry_requested);
    assert!(observed.try_recv().is_err());
    c.retire();
    drop(response);
    peer.join().unwrap();
}
#[test]
fn selection_ack_cannot_commit_after_target_lifetime_changes() {
    let (mut c, observed, response, peer) = fixture();
    let lifetime = c.selectable("right").unwrap();
    c.select_pane("right", &lifetime, OP, 0).unwrap();
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    c.current.remove("right");
    response.send(receipt()).unwrap();
    assert!(!settle(&mut c).selected);
    assert_eq!(c.selected(), "left");
    c.retire();
    drop(response);
    peer.join().unwrap();
}
#[test]
fn newest_fit_equal_observed_cancels_older_pending_fit() {
    let (mut c, _observed, response, peer) = fixture();
    c.viewport = Some((100, 24, "window.one".into(), 2000));
    c.viewport(9, 2, 1).unwrap();
    assert!(c.viewport.is_none());
    assert!(!c.geometry_requested);
    c.retire();
    drop(response);
    peer.join().unwrap();
}

#[test]
fn selection_is_input_ack_barrier_and_rejection_keeps_old_focus() {
    let (mut c, observed, response, peer) = fixture();
    let target = c.selectable("right").unwrap();
    let source = c.selectable("left").unwrap();
    c.policy
        .input_submission("left", &source, Input::Text("x".into()), 0)
        .unwrap();
    assert!(matches!(
        c.select_pane("right", &target, OP, 0),
        Err(Error::Control(tmux_control::Error::Busy))
    ));
    assert!(observed.try_recv().is_err());
    c.policy
        .accept_json(br#"{"type":"input-ack","pane":"left","seq":1}"#)
        .unwrap();
    c.select_pane("right", &target, OP, 0).unwrap();
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    response.send(json!({"type":"semantic-intent-ack","operationId":OP,"outcome":{"status":"rejected","code":"pane_not_active","message":"Selection refused"}})).unwrap();
    assert!(!settle(&mut c).selected);
    assert_eq!(c.selected(), "left");
    assert!(c.owns(Authority::Input));
    assert!(observed.try_recv().is_err());
    c.retire();
    drop(response);
    peer.join().unwrap();
}
#[test]
fn selection_timeout_reports_uncertainty_without_replay_or_resize() {
    let (mut c, observed, response, peer) = fixture();
    let target = c.selectable("right").unwrap();
    c.select_pane("right", &target, OP, 0).unwrap();
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    let update = c.poll(12000).unwrap();
    assert!(!update.selection.unwrap().selected);
    assert_eq!(c.selected(), "left");
    assert!(c.viewport.is_none());
    assert!(observed.try_recv().is_err());
    c.retire();
    drop(response);
    peer.join().unwrap();
}
#[test]
fn input_rejected_retires_immediately_without_waiting_for_ack_timeout() {
    let (mut c, observed, response, peer) = fixture();
    let source = c.selectable("left").unwrap();
    let _seq = c
        .input("left", &source, Input::Text("x".into()), 0)
        .unwrap();
    assert_eq!(
        observed.recv_timeout(Duration::from_secs(3)).unwrap()["type"],
        "input"
    );
    response
        .send(json!({"type":"error","protocolVersion":2,"code":"input-rejected","retryable":false}))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Err(error) = c.poll(1) {
            assert!(matches!(error, Error::Stopped(_)));
            assert!(!c.owns(Authority::Input));
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(1));
    }
    c.retire();
    drop(response);
    peer.join().unwrap();
}

#[test]
fn newest_fit_equal_observed_is_retained_when_different_fit_already_inflight() {
    let (mut c, _observed, response, peer) = fixture();
    c.inflight_viewport = Some((100, 24, "window.one".into()));
    c.viewport(9, 2, 1).unwrap();
    assert_eq!(
        c.viewport.as_ref().map(|(cols, rows, _, _)| (*cols, *rows)),
        Some((9, 2))
    );
    assert!(!c.geometry_requested);
    c.retire();
    drop(response);
    peer.join().unwrap();
}

#[test]
fn idle_poll_preserves_window_arc_without_rebuilding_copy_metadata() {
    let (mut c, _observed, response, peer) = fixture();
    let first = c.poll(1).unwrap().window.unwrap();
    let second = c.poll(2).unwrap().window.unwrap();
    assert!(Arc::ptr_eq(&first.paint, &second.paint));
    c.retire();
    drop(response);
    peer.join().unwrap();
}
#[test]
fn paste_facade_waits_for_exact_ack_before_each_suffix() {
    let (mut c, observed, response, peer) = fixture();
    let lifetime = c.selectable("left").unwrap();
    assert_eq!(
        c.begin_paste("left", &lifetime, &"x".repeat(1100), true, 0)
            .unwrap(),
        Some(1)
    );
    let first = observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(first["data"].as_str().unwrap().starts_with("\x1b[200~"));
    assert!(matches!(
        c.next_paste(0),
        Err(Error::Control(tmux_control::Error::Busy))
    ));
    for seq in 1..=2 {
        response
            .send(json!({"type":"input-ack","pane":"left","seq":seq}))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if c.poll(1).unwrap().inputs.iter().any(|i| i.sequence == seq) {
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        if seq == 1 {
            assert_eq!(c.next_paste(1).unwrap(), Some(2));
            let last = observed.recv_timeout(Duration::from_secs(3)).unwrap();
            assert!(last["data"].as_str().unwrap().ends_with("\x1b[201~"));
        }
    }
    assert_eq!(c.next_paste(2).unwrap(), None);
    c.retire();
    drop(response);
    peer.join().unwrap();
}

#[path = "tmux_controller_pixel_tests.rs"]
mod pixels;

#[path = "tmux_controller_projection_tests.rs"]
mod projection;
