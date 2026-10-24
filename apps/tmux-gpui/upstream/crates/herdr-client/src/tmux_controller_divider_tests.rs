use super::*;
fn gesture() -> Gesture {
    Gesture {
        id: "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c".into(),
        target: SplitTarget {
            window: WindowLink {
                live_session_id: "live-session.01234567890123456789".into(),
                link_id: format!("window-link.{}", "a".repeat(32)),
                expected_semantic_window_id: "window".into(),
                link_revision: 1,
            },
            layout_id: "b987f903-e864-43dd-8591-8d0a464ca6e8".into(),
            split_id: "e01ce8ee-74d8-40d0-9a59-a096050a6ade".into(),
            boundary: 40,
        },
        axis: Axis::Cols,
        desired: 41,
        released: true,
        operation: None,
        successor: None,
        deadline: 100,
        geometry_requested: false,
        cancelled: false,
    }
}
#[test]
fn cancellation_retains_submitted_correlation_but_discards_unsent_gesture() {
    let mut state = DividerState {
        active: Some(gesture()),
        ..Default::default()
    };
    state.cancel();
    assert!(!state.busy());
    assert_eq!(
        state.publication().map(|p| p.phase),
        Some(SplitPhase::Cancelled)
    );
    let mut sent = gesture();
    sent.operation = Some("submitted".into());
    state.active = Some(sent);
    state.cancel();
    assert!(state.busy());
    assert!(
        state
            .active
            .as_ref()
            .is_some_and(|g| g.cancelled && g.operation.as_deref() == Some("submitted"))
    );
}
#[test]
fn pending_publication_never_exposes_successor_as_observed_target() {
    let mut state = DividerState {
        active: Some(gesture()),
        ..Default::default()
    };
    state.publish(SplitPhase::Pending);
    assert!(state.publication().is_some_and(|p| p.target.is_none()));
    state.publish(SplitPhase::Settled);
    assert!(
        state
            .publication()
            .is_some_and(|p| p.target.as_ref().is_some_and(|t| t.boundary == 40))
    );
}

fn update() -> Update {
    Update {
        panes: Default::default(),
        window: None,
        inputs: vec![],
        controls: vec![],
        intents: vec![],
        viewports: vec![],
        geometry_timeouts: vec![],
        intent_timeouts: vec![],
        presence_revision: None,
        selection: None,
        graphics: vec![],
        graphics_placements: Default::default(),
        cell_pixels: false,
        precise_cell_pixels: false,
    }
}
#[test]
fn cancelled_sent_gesture_finishes_without_current_scope() {
    let mut g = gesture();
    g.operation = Some("sent".into());
    let mut state = DividerState {
        active: Some(g),
        ..Default::default()
    };
    state.cancel();
    let revision = state.revision;
    state.cancel();
    assert_eq!(state.revision, revision);
    state.finish_cancelled(&update(), 99);
    assert!(state.busy());
    let mut result = update();
    result.intent_timeouts.push("sent".into());
    state.finish_cancelled(&result, 99);
    assert!(!state.busy());
    assert_eq!(
        state.publication().map(|p| p.phase),
        Some(SplitPhase::Cancelled)
    );
}
#[test]
fn cancelled_sent_gesture_expires_without_receipt() {
    let mut g = gesture();
    g.operation = Some("sent".into());
    let mut state = DividerState {
        active: Some(g),
        ..Default::default()
    };
    state.cancel();
    state.finish_cancelled(&update(), 100);
    assert!(!state.busy());
    assert_eq!(
        state.publication().map(|p| p.phase),
        Some(SplitPhase::Cancelled)
    );
}

#[test]
fn canonical_resource_requires_exact_members_and_rectangles()
-> Result<(), Box<dyn std::error::Error>> {
    let layout: Layout = serde_json::from_value(serde_json::json!({
        "type":"layout","semanticWindowId":"window","windowName":"test",
        "currentWindow":true,"cols":80,"rows":24,"zoomed":false,
        "paneBorderStatus":"off","modeKeys":"emacs",
        "panes":[{"pane":"pane","left":0,"top":0,"width":80,"height":24,"active":true}]
    }))?;
    let resource = SplitLayout {
        version: 1,
        window: gesture().target.window,
        layout_id: gesture().target.layout_id,
        cols: 80,
        rows: 24,
        panes: vec![tmux_control::SplitPane {
            semantic_pane_id: "pane".into(),
            left: 0,
            top: 0,
            width: 80,
            height: 24,
        }],
        splits: vec![],
    };
    assert!(matches_geometry(&resource, &layout));
    let mut changed = layout.clone();
    changed.panes[0].pane = Some("replacement".into());
    assert!(!matches_geometry(&resource, &changed));
    changed = layout.clone();
    changed.panes[0].width = 79;
    assert!(!matches_geometry(&resource, &changed));
    changed = layout.clone();
    changed.zoomed = true;
    assert!(!matches_geometry(&resource, &changed));
    changed = layout.clone();
    changed.panes[0].active = false;
    changed.panes[0].display_name = Some("renamed".into());
    assert!(same_geometry(&layout, &changed));
    changed.panes[0].top = 1;
    assert!(!same_geometry(&layout, &changed));
    Ok(())
}

mod live {
    #![allow(clippy::unwrap_used)]
    use super::super::super::*;
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

    #[test]
    fn focus_cycle_preserves_metadata_and_never_resizes() {
        let (mut c, observed, _response, peer) = fixture();
        c.topology.apply_control(&serde_json::value::to_raw_value(&json!({
        "type":"layout-snapshot","topologyEpoch":1,"layouts":[{
        "type":"layout","semanticWindowId":"window.one","currentWindow":true,
        "cols":9,"rows":2,"zoomed":false,"paneBorderStatus":"off",
        "panes":[{"pane":"left","left":0,"top":0,"width":4,"height":2,"active":true},{"pane":"right","left":5,"top":0,"width":4,"height":2,"active":false}]
        }],"windowLinks":{"liveSessionId":"live-session.01234567890123456789",
        "linkRevision":1,"activeLinkId":format!("window-link.{}","a".repeat(32)),
        "links":[{"linkId":format!("window-link.{}","a".repeat(32)),"semanticWindowId":"window.one","displayIndex":0}]}
    })).unwrap()).unwrap();
        let mut state = DividerState::default();
        state.observe(&mut c, &update(), 0).unwrap();
        assert!(state.take_read().is_some());
        let sequence = state.read_sequence;
        state.rebind_request().unwrap();
        assert_eq!(state.take_read().map(|r| r.sequence), Some(sequence + 1));
        let sequence = state.read_sequence;
        let lifetime = state.lifetime.clone();
        c.desired_presence = Some((false, 1));
        state.cancel();
        state.observe(&mut c, &update(), 1).unwrap();
        assert!(state.take_read().is_none());
        assert_eq!(state.read_sequence, sequence);
        assert_eq!(state.lifetime, lifetime);
        assert!(
            state
                .begin(&mut c, TOKEN, gesture().target, Axis::Cols, 1)
                .is_err()
        );
        c.desired_presence = None;
        state.observe(&mut c, &update(), 2).unwrap();
        assert!(state.take_read().is_none());
        assert_eq!(state.read_sequence, sequence);
        assert!(observed.try_recv().is_err());
        state.resource = Some(SplitLayout {
            version: 1,
            window: state.scope.as_ref().unwrap().window.clone(),
            layout_id: gesture().target.layout_id,
            cols: 9,
            rows: 2,
            panes: vec![],
            splits: vec![],
        });
        state.rebind_request().unwrap();
        assert!(state.take_read().is_none());
        assert!(state.resource().is_some());
        assert_eq!(state.read_sequence, sequence);
        c.retire();
        peer.join().unwrap();
    }
}

#[test]
fn request_rebind_does_not_replay_active_gesture_or_unscoped_read() -> Result<(), Error> {
    let mut state = DividerState::default();
    state.rebind_request()?;
    assert!(state.take_read().is_none());
    state.active = Some(gesture());
    state.rebind_request()?;
    assert!(state.take_read().is_none());
    assert_eq!(state.read_sequence, 0);
    Ok(())
}

#[test]
fn local_rejection_is_bounded_and_preserves_accepted_gesture() {
    let mut state = DividerState::default();
    state.reject("not-an-id", 40);
    assert!(state.publication().is_none());
    let id = gesture().id;
    state.reject(&id, 40);
    assert_eq!(
        state.publication().map(|p| p.phase),
        Some(SplitPhase::Failed)
    );
    assert!(state.publication().is_some_and(|p| p.target.is_none()));
    let mut pending = gesture();
    pending.operation = Some("accepted".into());
    state.active = Some(pending);
    state.publish(SplitPhase::Pending);
    state.reject(&id, 41);
    assert!(state.busy());
    assert_eq!(
        state.publication().map(|p| p.phase),
        Some(SplitPhase::Pending)
    );
    assert!(state.matches_gesture(&id));
    assert!(!state.matches_gesture("another"));
}
