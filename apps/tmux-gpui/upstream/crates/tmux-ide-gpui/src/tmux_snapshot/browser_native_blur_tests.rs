#![allow(clippy::unwrap_used)]
//! Card #875: a line typed just before the window leaves (the soak's
//! `bg-fg-flap#661` over SSH, 24 Nov 2026). The line and the focus loss reach
//! the terminal loop in one turn: the loop waits up to 5 ms between turns and
//! a window command does not wake it. Keys are never sent once the window has
//! left, so the window must say they were not sent when it is back.
//!
//! These drive the real terminal loop (`start_events`) against a scripted
//! daemon stream on loopback. No daemon, tmux or SSH is started.
use super::super::*;
use crate::tmux_snapshot::keys::Input;
use herdr_client::{tmux_handoff::Handoff, tmux_stream};
use serde_json::{Value, json};
use std::{
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const GEN: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const ID: &str = "b987f903-e864-43dd-8591-8d0a464ca6e8";
const NONCE: &str = "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c";
const SESSION: &str = "live-session.01234567890123456789";
/// The words the window shows once it is back (#875).
const NOTICE: &str = "Keys typed as the window lost focus were not sent. Type them again.";
// Base64 of the shared native compact seed vector (4 columns, 2 rows).
const SEED: &str = "eyJmIjoicyIsImsiOiJ0ZXJtaW5hbC1zZW1hbnRpYy1jb21wYWN0IiwiciI6MSwicyI6WzQsMixbWzAsW1sxLCJBIiwxLDAsMCwwXSxbMSwiw6kiLDEsMCwwLDBdLFsxLCLnlYwiLDIsMCwwLDBdLFsxLCIiLDAsMCwwLDBdXV0sWzEsW1s0LCIgIiwxLDAsMCwwXV1dXSxbWzAsW1s0LCJoIiwxLDAsMCwwXV1dXSxbMiwxLDAsImJhciIsMV0sWzAsMSwwLDEsMCwwLDEsMSwiZHJhZyIsInNnciIsMF0sW1siaW1hZ2U6MSIsImtpdHR5IiwwLDAsMiwxLCJhYmMiXV0sWyJhdXRob3JpdGF0aXZlLXN0cmVhbSIsIm9ic2VydmVkLWZyb20tc3RhcnQiXV0sInYiOjF9";

/// A daemon's pane stream: two panes, input granted on every request and
/// released on every release, every input answered. Each message the app
/// sends is passed on to `seen`.
fn daemon(listener: TcpListener, seen: mpsc::Sender<Value>) {
    let (stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
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
    let send = |socket: &mut tungstenite::WebSocket<std::net::TcpStream>, value: Value| {
        socket
            .send(tungstenite::Message::Text(value.to_string().into()))
            .unwrap()
    };
    send(
        &mut socket,
        json!({"type":"ready","protocolVersion":2,"daemonInstanceId":GEN,"requestId":ID,"panes":["left","right"],"effectiveViewerMode":"interactive","connectionClientId":"native.test","inputLifetime":true}),
    );
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../herdr-client/src/tmux_delivery/tests/vectors.json"
    ))
    .unwrap();
    let vector = &vectors[0];
    for pane in ["left", "right"] {
        send(
            &mut socket,
            json!({"type":"terminal-delivery-ready","pane":pane,"negotiation":{"accepted":true,"negotiated":{"protocolVersion":1,"encoding":"semantic-compact-v1","richPlacements":true,"generation":GEN,"deliveryNonce":NONCE}}}),
        );
        send(
            &mut socket,
            json!({"type":"terminal-delivery-envelope","pane":pane,"envelope":{"type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":pane,"generation":GEN,"incarnation":format!("birth-{pane}"),"deliveryNonce":NONCE,"transactionId":ID,"protocolVersion":1,"encoding":"semantic-compact-v1","frame":"seed","baseRevision":null,"canonicalRevision":1,"canonicalStateHash":vector["canonicalHash"],"representationHash":vector["representationHash"],"representationBytes":vector["wire"].as_str().unwrap().len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true}}),
        );
        send(
            &mut socket,
            json!({"type":"terminal-delivery-chunk","pane":pane,"transactionId":ID,"index":0,"data":SEED}),
        );
    }
    send(
        &mut socket,
        json!({"type":"layout","semanticWindowId":"window","currentWindow":true,"cols":9,"rows":2,"zoomed":false,"paneBorderStatus":"off","panes":[{"pane":"left","left":0,"top":0,"width":4,"height":2,"active":true},{"pane":"right","left":5,"top":0,"width":4,"height":2,"active":false}]}),
    );
    let mut revision = 1;
    while let Ok(message) = socket.read() {
        let tungstenite::Message::Text(text) = message else {
            if message.is_close() {
                break;
            }
            continue;
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        let kind = value["type"].as_str().unwrap_or_default();
        let granted = kind == "authority-request" && value["authority"] == "input";
        if granted || kind == "authority-release" {
            revision += 1;
            let owner = if granted {
                json!("native.test")
            } else {
                Value::Null
            };
            let snapshot = json!({"generation":GEN,"session":"workspace","revision":revision,"owners":{"input":owner,"focus":null,"geometry":null},"nativeGeometryYieldUntilMs":0,"clients":[]});
            let receipt = if granted {
                json!({"type":"authority-receipt","requestId":value["requestId"],"authority":"input","status":"granted","lease":{"generation":GEN,"session":"workspace","clientId":"native.test","authority":"input","token":NONCE,"revision":revision},"snapshot":snapshot})
            } else {
                json!({"type":"authority-receipt","requestId":value["requestId"],"authority":value["authority"],"status":"released","snapshot":snapshot})
            };
            send(&mut socket, receipt);
        }
        if kind == "input" {
            send(
                &mut socket,
                json!({"type":"input-ack","pane":value["pane"],"seq":value["seq"]}),
            );
        }
        let _ = seen.send(value);
    }
}

fn handoff(port: u16) -> Handoff {
    let expires = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
        + 30_000;
    Handoff::parse(&serde_json::to_vec(&json!({"descriptor":{"protocolVersion":2,"webSocketUrl":format!("ws://127.0.0.1:{port}/v2/terminal/pane-streams/redeem"),"subprotocol":tmux_stream::SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":GEN,"requestId":ID,"expiresAt":expires,"panes":["left","right"],"effectiveViewerMode":"interactive"},"origin":"http://127.0.0.1:4000","hostClientId":"native.test","workspaceName":"workspace","selectedPane":"left"})).unwrap()).unwrap()
}

/// The terminal loop on a scripted stream, with input ready in the
/// foreground. While `gate` is set, the loop's owner blocks on the next focus
/// change it passes on, so the test can put commands into one turn.
struct Loop {
    bridge: Bridge,
    seen: mpsc::Receiver<Value>,
    gate: Arc<AtomicBool>,
    open: mpsc::Sender<()>,
    _events: mpsc::SyncSender<Incoming>,
}
impl Loop {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_tx, seen) = mpsc::channel();
        thread::spawn(move || daemon(listener, seen_tx));
        let (events, receiver) = mpsc::sync_channel(8);
        let gate = Arc::new(AtomicBool::new(false));
        let (open, opened) = mpsc::channel::<()>();
        let held = gate.clone();
        let bridge = start_events(Default::default(), receiver, true, move || {
            move |command| {
                if matches!(command, Command::Presence { .. }) && held.swap(false, Ordering::SeqCst)
                {
                    let _ = opened.recv_timeout(Duration::from_secs(5));
                }
                Ok(())
            }
        });
        events
            .send(Incoming::Catalog(Box::new(State {
                request: 3,
                surface: Surface::Workspace,
                selected_session: Some(SESSION.into()),
                ..State::default()
            })))
            .unwrap();
        events
            .send(Incoming::Handoff(Event::Open {
                version: 1,
                id: ID.into(),
                request: 3,
                live_session_id: SESSION.into(),
                capability: Box::new(handoff(port)),
            }))
            .unwrap();
        let mut running = Self {
            bridge,
            seen,
            gate,
            open,
            _events: events,
        };
        running.until("input ready", |state| state.input_ready);
        running
    }
    /// The next publication that `wanted` accepts, within 5 s.
    fn until(&mut self, what: &str, wanted: impl Fn(&State) -> bool) -> State {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut last = None;
        loop {
            let next = self.bridge.mailbox.lock().unwrap().take();
            match next {
                Some(Some(state)) if wanted(&state) => return state,
                Some(Some(state)) => last = Some(state),
                Some(None) => panic!("the terminal loop ended while waiting for {what}"),
                None => {
                    assert!(
                        Instant::now() < deadline,
                        "never published: {what}; last: {:?}",
                        last.as_ref().map(|s: &State| (
                            &s.status,
                            s.input_ready,
                            s.presence_revision,
                            s.request
                        ))
                    );
                    thread::sleep(Duration::from_millis(2));
                }
            }
        }
    }
    fn send(&self, command: Command) {
        self.bridge.commands.send(command).unwrap();
    }
    /// Sends `commands` so that the loop takes all of them in one turn: it is
    /// held on a focus change it already took until they are all queued.
    fn one_turn(&self, revision: u64, commands: Vec<Command>) {
        self.gate.store(true, Ordering::SeqCst);
        self.send(Command::Presence {
            active: true,
            revision,
        });
        for command in commands {
            self.send(command);
        }
        self.open.send(()).unwrap();
    }
    /// Every line typed into pane `left` that the daemon received, in order.
    fn typed(&self) -> Vec<String> {
        self.seen
            .try_iter()
            .filter(|value| value["type"] == "input")
            .map(|value| value.to_string())
            .collect()
    }
}

fn line(n: u64) -> Vec<Command> {
    [
        Input::Text(format!("printf 'hb-%s\\n' {n}")),
        Input::Key("Enter".into()),
    ]
    .into_iter()
    .map(|input| Command::Input {
        request: 3,
        id: "left".into(),
        input_target: None,
        input,
    })
    .collect()
}
fn focus(active: bool, revision: u64) -> Command {
    Command::Presence { active, revision }
}

/// The soak's case: the line, then the focus loss, in one turn. The line is
/// not sent, and once the window is back it says so.
#[test]
fn a_line_queued_when_the_window_leaves_is_announced_as_not_sent() {
    let mut app = Loop::start();
    let mut commands = line(4402);
    commands.push(focus(false, 1));
    app.one_turn(0, commands);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    thread::sleep(Duration::from_millis(100));
    let sent_in_background = app.typed();
    app.send(focus(true, 2));
    let back = app.until("the window back with input", |state| {
        state.presence_revision == 2 && state.input_ready
    });
    thread::sleep(Duration::from_millis(100));
    let sent = [sent_in_background, app.typed()].concat();
    assert!(
        sent.is_empty(),
        "a key went out after the window left: {sent:?}"
    );
    assert_eq!(
        back.status, NOTICE,
        "line 4402 was neither sent nor announced as not sent"
    );
    // The next line goes out, once; line 4402 never follows it.
    for command in line(4403) {
        app.send(command);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sent = Vec::new();
    while sent.len() < 2 {
        sent.extend(app.typed());
        assert!(
            Instant::now() < deadline,
            "line 4403 was not sent: {sent:?}"
        );
        thread::sleep(Duration::from_millis(2));
    }
    assert!(sent[0].contains("4403"), "{sent:?}");
    assert!(sent[1].contains("Enter"), "{sent:?}");
    thread::sleep(Duration::from_millis(100));
    assert!(app.typed().is_empty(), "a line was sent twice");
}

/// A key that reaches the loop after the focus loss, in the same turn, is
/// refused there. It says so too.
#[test]
fn a_key_after_the_focus_loss_in_the_same_turn_is_announced_as_not_sent() {
    let mut app = Loop::start();
    let mut commands = vec![focus(false, 1)];
    commands.extend(line(4402));
    app.one_turn(0, commands);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    app.send(focus(true, 2));
    let back = app.until("the window back with input", |state| {
        state.presence_revision == 2 && state.input_ready
    });
    thread::sleep(Duration::from_millis(100));
    assert!(app.typed().is_empty(), "a key went out from the background");
    assert_eq!(back.status, NOTICE, "the refused line was not announced");
}

/// A focus change with only a window fit queued is not a lost key: no notice.
#[test]
fn a_fit_dropped_with_the_focus_loss_says_nothing() {
    let mut app = Loop::start();
    let fit = Command::Input {
        request: 3,
        id: "left".into(),
        input_target: None,
        input: Input::Resize {
            cols: 9,
            rows: 2,
            cell_width: None,
            cell_height: None,
            cell_width_milli: None,
            cell_height_milli: None,
        },
    };
    app.one_turn(0, vec![fit, focus(false, 1)]);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    app.send(focus(true, 2));
    let back = app.until("the window back with input", |state| {
        state.presence_revision == 2 && state.input_ready
    });
    assert_eq!(back.status, "Connected");
}

/// A key the input scheduler holds back (eight earlier ones are unanswered,
/// a link's round trip) is cancelled by the focus loss: it says so too. A
/// held-back wheel step is not a key and says nothing.
#[test]
fn a_key_held_back_by_the_scheduler_is_announced_as_not_sent() {
    for (last, notice) in [(Input::Text("x".into()), true), (wheel(), false)] {
        let (mut active, mut state, _seen, peer) = selection_tests::fixture(true);
        for n in 0..8 {
            active
                .input("left", None, Input::Text(n.to_string()), 1)
                .unwrap();
        }
        active.input("left", None, last, 1).unwrap();
        assert!(active.input.waiting());
        super::blur(&mut std::collections::VecDeque::new(), Some(&mut active));
        active.input.focus_loss();
        active.poll(&mut state, true, 2).unwrap();
        assert_eq!(state.status == NOTICE, notice, "{}", state.status);
        active.controller.retire();
        peer.join().unwrap();
    }
}
fn wheel() -> Input {
    Input::Wheel {
        lines: -1,
        row: 0,
        col: 0,
        shift: false,
        alt: false,
        control: false,
    }
}
