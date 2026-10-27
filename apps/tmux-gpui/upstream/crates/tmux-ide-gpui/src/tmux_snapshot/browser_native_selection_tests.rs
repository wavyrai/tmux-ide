#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::{tmux_handoff::Handoff, tmux_stream};
use serde_json::{Value, json};
use std::{
    net::TcpListener,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
const GEN: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const ID: &str = "b987f903-e864-43dd-8591-8d0a464ca6e8";
const NONCE: &str = "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c";
// Base64 of the shared native compact seed vector (4 columns, 2 rows).
const SEED: &str = "eyJmIjoicyIsImsiOiJ0ZXJtaW5hbC1zZW1hbnRpYy1jb21wYWN0IiwiciI6MSwicyI6WzQsMixbWzAsW1sxLCJBIiwxLDAsMCwwXSxbMSwiw6kiLDEsMCwwLDBdLFsxLCLnlYwiLDIsMCwwLDBdLFsxLCIiLDAsMCwwLDBdXV0sWzEsW1s0LCIgIiwxLDAsMCwwXV1dXSxbWzAsW1s0LCJoIiwxLDAsMCwwXV1dXSxbMiwxLDAsImJhciIsMV0sWzAsMSwwLDEsMCwwLDEsMSwiZHJhZyIsInNnciIsMF0sW1siaW1hZ2U6MSIsImtpdHR5IiwwLDAsMiwxLCJhYmMiXV0sWyJhdXRob3JpdGF0aXZlLXN0cmVhbSIsIm9ic2VydmVkLWZyb20tc3RhcnQiXV0sInYiOjF9";
fn fixture(with_authority: bool) -> (Active, State, mpsc::Receiver<Value>, thread::JoinHandle<()>) {
    fixture_with_batch_ack(with_authority, false)
}
fn fixture_with_batch_ack(
    with_authority: bool,
    batch_ack: bool,
) -> (Active, State, mpsc::Receiver<Value>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    let peer = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        #[allow(clippy::result_large_err)]
        let mut socket = tungstenite::accept_hdr(
            stream,
            |_: &tungstenite::handshake::server::Request,
             mut response: tungstenite::handshake::server::Response| {
                response.headers_mut().insert(
                    "Sec-WebSocket-Protocol",
                    tmux_stream::SUBPROTOCOL.parse().unwrap(),
                );
                Ok(response)
            },
        )
        .unwrap();
        socket.read().unwrap();
        let mut send = |value: Value| {
            socket
                .send(tungstenite::Message::Text(value.to_string().into()))
                .unwrap()
        };
        send(
            json!({"type":"ready","protocolVersion":2,"daemonInstanceId":GEN,"requestId":ID,"panes":["left","right"],"effectiveViewerMode":"interactive","connectionClientId":"native.test","inputLifetime":true}),
        );
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../herdr-client/src/tmux_delivery/tests/vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        for pane in ["left", "right"] {
            send(
                json!({"type":"terminal-delivery-ready","pane":pane,"negotiation":{"accepted":true,"negotiated":{"protocolVersion":1,"encoding":"semantic-compact-v1","richPlacements":true,"generation":GEN,"deliveryNonce":NONCE}}}),
            );
            send(
                json!({"type":"terminal-delivery-envelope","pane":pane,"envelope":{"type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":pane,"generation":GEN,"incarnation":format!("birth-{pane}"),"deliveryNonce":NONCE,"transactionId":ID,"protocolVersion":1,"encoding":"semantic-compact-v1","frame":"seed","baseRevision":null,"canonicalRevision":1,"canonicalStateHash":vector["canonicalHash"],"representationHash":vector["representationHash"],"representationBytes":vector["wire"].as_str().unwrap().len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true}}),
            );
            send(
                json!({"type":"terminal-delivery-chunk","pane":pane,"transactionId":ID,"index":0,"data":SEED}),
            );
        }
        send(
            json!({"type":"layout","semanticWindowId":"window","currentWindow":true,"cols":9,"rows":2,"zoomed":false,"paneBorderStatus":"off","panes":[{"pane":"left","left":0,"top":0,"width":4,"height":2,"active":true},{"pane":"right","left":5,"top":0,"width":4,"height":2,"active":false}]}),
        );
        let mut pending_inputs = Vec::new();
        while let Ok(message) = socket.read() {
            if let tungstenite::Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).unwrap();
                if with_authority
                    && value["type"] == "authority-request"
                    && value["authority"] == "input"
                {
                    let authority = json!({"generation":GEN,"session":"workspace","revision":1,"owners":{"input":"native.test","focus":null,"geometry":null},"nativeGeometryYieldUntilMs":0,"clients":[]});
                    socket.send(tungstenite::Message::Text(json!({"type":"authority-receipt","requestId":value["requestId"],"authority":"input","status":"granted","lease":{"generation":GEN,"session":"workspace","clientId":"native.test","authority":"input","token":NONCE,"revision":1},"snapshot":authority}).to_string().into())).unwrap();
                }
                if batch_ack && value["type"] == "input" {
                    pending_inputs.push(value["seq"].clone());
                    if pending_inputs.len() == 2 {
                        for seq in pending_inputs.drain(..) {
                            socket
                                .send(tungstenite::Message::Text(
                                    json!({"type":"input-ack","pane":"left","seq":seq})
                                        .to_string()
                                        .into(),
                                ))
                                .unwrap();
                        }
                    }
                }
                let _ = tx.send(value);
            } else if message.is_close() {
                break;
            }
        }
    });
    let handoff=Handoff::parse(&serde_json::to_vec(&json!({"descriptor":{"protocolVersion":2,"webSocketUrl":format!("ws://127.0.0.1:{port}/v2/terminal/pane-streams/redeem"),"subprotocol":tmux_stream::SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":GEN,"requestId":ID,"expiresAt":u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()+30000,"panes":["left","right"],"effectiveViewerMode":"interactive"},"origin":"http://127.0.0.1:4000","hostClientId":"native.test","workspaceName":"workspace","selectedPane":"left"})).unwrap()).unwrap();
    let session = "live-session.01234567890123456789";
    let mut active = Active {
        stream_interrupted: false,
        id: ID.into(),
        request: 3,
        input_epoch: 3,
        session: session.into(),
        controller: Controller::spawn(handoff).unwrap(),
        presentation: NativePresentation::new(ID, "workspace"),
        graphics: Graphics::new(Default::default()),
        #[cfg(target_os = "macos")]
        surfaces: Default::default(),
        input: InputOwner::default(),
        selection_notice: None,
        history: History::new(
            None,
            "workspace".into(),
            session.into(),
            "left".into(),
            Default::default(),
        ),
        editor: Editor::default(),
        editor_notice: None,
        history_notice: None,
        actions: ActionOwner::default(),
        divider: DividerOwner::default(),
        split_notice: None,
        reissue: false,
        preferred_pane: None,
        owner: Owner::new(ID.into(), 3, "workspace".into(), session.into(), GEN.into()).unwrap(),
        owner_notice: None,
        action_status: None,
        catalog_only: false,
        generation: GEN.into(),
        topology_notice: None,
        topology_sent: Default::default(),
        metadata_notice: None,
        metadata_sent: None,
    };
    let mut state = State {
        request: 3,
        selected_session: Some(session.into()),
        ..Default::default()
    };
    if with_authority {
        active.controller.presence(true, 1, 0).unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while active.controller.selectable("right").is_none() || (with_authority && !state.input_ready)
    {
        active.poll(&mut state, 0).unwrap();
        assert!(Instant::now() < deadline, "canonical panes did not arrive");
        thread::sleep(Duration::from_millis(1));
    }
    (active, state, rx, peer)
}
#[test]
fn coherent_selection_without_input_authority_completes_refusal_instead_of_stalling_request() {
    let (mut active, mut state, observed, peer) = fixture(false);
    assert!(!state.input_ready);
    assert!(active.controller.selectable("right").is_some());
    assert!(active.presentation.resolve("left", None).is_none());
    let result = active.select("right", 4, 1);
    // The UI has accepted request 4 already; even a refused navigation needs a completion.
    assert!(
        result.is_ok(),
        "navigation was silently dropped: {result:?}"
    );
    active.poll(&mut state, 2).unwrap();
    assert_eq!(active.request, 4);
    assert!(state.input_target_rejected);
    assert!(matches!(
        active.selection_notice,
        Some(Command::NativePaneSelected {
            request: 4,
            from_request: 3,
            ..
        })
    ));
    assert!(
        observed
            .try_iter()
            .all(|v| v["type"] == "terminal-delivery-ack")
    );
    active.controller.retire();
    peer.join().unwrap();
}

#[test]
fn blur_cancels_queued_selection_and_completes_newest_request_without_replaying_input() {
    let (mut active, mut state, observed, peer) = fixture(true);
    active
        .input(
            "left",
            None,
            crate::tmux_snapshot::keys::Input::Text("a".into()),
            1,
        )
        .unwrap();
    active.select("right", 4, 2).unwrap();
    assert!(active.input.waiting());
    // A newer request may already have reached navigation while the older barrier waits.
    active.select("right", 5, 3).unwrap();
    active.input.focus_loss();
    active.controller.presence(false, 2, 4).unwrap();
    active.poll(&mut state, 5).unwrap();
    assert_eq!(active.request, 5);
    assert!(state.input_target_rejected);
    assert!(matches!(
        active.selection_notice,
        Some(Command::NativePaneSelected {
            request: 5,
            from_request: 3,
            ..
        })
    ));
    assert!(!active.input.waiting());
    assert!(
        active.input.busy(),
        "accepted input correlation must survive blur"
    );
    let mut input_count = 0;
    while let Ok(value) = observed.recv_timeout(Duration::from_millis(50)) {
        assert_ne!(value["type"], "semantic-intent");
        if value["type"] == "input" {
            input_count += 1;
        }
    }
    assert_eq!(input_count, 1);
    active.select("right", 4, 6).unwrap();
    assert_eq!(active.request, 5, "old requests cannot reopen navigation");
    active.controller.retire();
    peer.join().unwrap();
}

#[test]
fn refused_newer_navigation_does_not_retire_accepted_input_correlation() {
    let (mut active, mut state, observed, peer) = fixture_with_batch_ack(true, true);
    active
        .input(
            "left",
            None,
            crate::tmux_snapshot::keys::Input::Text("a".into()),
            1,
        )
        .unwrap();
    active.select("right", 4, 2).unwrap();
    active.select("right", 5, 3).unwrap();
    active.poll(&mut state, 4).unwrap();
    assert_eq!(active.request, 5);
    assert_eq!(active.input_epoch, 3);
    assert!(!active.input.waiting());
    active
        .input(
            "left",
            None,
            crate::tmux_snapshot::keys::Input::Text("b".into()),
            5,
        )
        .unwrap();
    assert!(active.input.busy());
    let mut input_count = 0;
    while let Ok(value) = observed.recv_timeout(Duration::from_millis(50)) {
        assert_ne!(value["type"], "semantic-intent");
        if value["type"] == "input" {
            input_count += 1;
        }
    }
    assert_eq!(input_count, 2);
    let deadline = Instant::now() + Duration::from_secs(3);
    while active.input.busy() {
        active.poll(&mut state, 6).unwrap();
        assert!(
            Instant::now() < deadline,
            "accepted input ACKs did not drain"
        );
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(active.controller.selected(), "left");
    assert_eq!(active.request, 5);
    assert!(
        observed
            .try_iter()
            .all(|value| value["type"] != "semantic-intent")
    );
    active.controller.retire();
    peer.join().unwrap();
}

#[test]
fn catalog_repaint_does_not_cancel_pending_editor_read() {
    let (mut active, mut state, _observed, peer) = fixture(true);
    let token = state.pane_actions.as_ref().unwrap().token.clone();
    let request = active
        .editor
        .submit(
            &active.controller,
            &active.presentation,
            ReadContext {
                id: ID,
                request: 3,
                pane: "left",
                token: &token,
                presence: 1,
            },
            1,
        )
        .unwrap();
    active.presentation.invalidate_overlay();
    active.poll(&mut state, 2).unwrap();
    assert!(
        active.editor_notice.is_none(),
        "catalog repaint cancelled a current editor read"
    );
    assert_eq!(
        active.editor.response(EditorResponse::native(
            &request,
            crate::tmux_snapshot::browser_native_editor::Status::Unavailable
        )),
        Some("Open folder requires verified local daemon discovery")
    );
    active.controller.retire();
    peer.join().unwrap();
}

#[test]
fn editor_result_waits_for_repaint_and_still_rejects_focus_loss() {
    for blurred in [false, true] {
        let (mut active, mut state, _observed, peer) = fixture(true);
        let token = state.pane_actions.as_ref().unwrap().token.clone();
        let request = active
            .editor
            .submit(
                &active.controller,
                &active.presentation,
                ReadContext {
                    id: ID,
                    request: 3,
                    pane: "left",
                    token: &token,
                    presence: 1,
                },
                1,
            )
            .unwrap();
        assert!(active.editor.receive(EditorResponse::native(
            &request,
            crate::tmux_snapshot::browser_native_editor::Status::Unavailable
        )));
        active.presentation.invalidate_overlay();
        if blurred {
            active.controller.presence(false, 2, 2).unwrap();
        }
        active.poll(&mut state, 3).unwrap();
        assert_eq!(active.editor_notice.is_some(), blurred);
        assert_eq!(
            state.status == "Open folder requires verified local daemon discovery",
            !blurred
        );
        assert!(active.editor.finish_response().is_none());
        active.controller.retire();
        peer.join().unwrap();
    }
}
