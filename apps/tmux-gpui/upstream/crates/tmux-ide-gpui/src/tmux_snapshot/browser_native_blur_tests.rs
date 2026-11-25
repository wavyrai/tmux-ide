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
        atomic::{AtomicBool, AtomicU64, Ordering},
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

/// How the scripted daemon departs from the plain one.
#[derive(Clone, Default)]
struct Script {
    /// The stream closes when the app gives input up (the window left): a
    /// link that drops while the user is in another app.
    close_on_release: bool,
    /// While set, inputs are not answered: a link's round trip, so the input
    /// scheduler holds a ninth key back. Answered once cleared.
    hold_acks: Arc<AtomicBool>,
}

/// A daemon's pane stream: two panes, input granted on every request and
/// released on every release, every input answered. Each message the app
/// sends is passed on to `seen`.
fn daemon(listener: TcpListener, seen: mpsc::Sender<Value>, script: Script) {
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
    // From here a read gives up after 20 ms, so held answers go out on time.
    socket
        .get_ref()
        .set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();
    let mut unanswered: Vec<Value> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if !script.hold_acks.load(Ordering::SeqCst) {
            for (pane, seq) in unanswered
                .drain(..)
                .map(|v| (v["pane"].clone(), v["seq"].clone()))
            {
                send(
                    &mut socket,
                    json!({"type":"input-ack","pane":pane,"seq":seq}),
                );
            }
        }
        let message = match socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(_) => break,
        };
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
            if script.close_on_release && !granted && value["authority"] == "input" {
                let _ = seen.send(value);
                let _ = socket.close(None);
                let _ = socket.flush();
                return;
            }
        }
        if kind == "input" {
            unanswered.push(value.clone());
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
    events: mpsc::SyncSender<Incoming>,
    seen_tx: mpsc::Sender<Value>,
    /// The revision of the last focus change the loop passed on.
    passed_on: Arc<AtomicU64>,
}
/// A scripted daemon on a fresh loopback port.
fn listen(seen: &mpsc::Sender<Value>, script: Script) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = seen.clone();
    thread::spawn(move || daemon(listener, seen, script));
    port
}
/// The catalog's open of request `request` on `port`.
fn open(events: &mpsc::SyncSender<Incoming>, request: u64, port: u16) {
    events
        .send(Incoming::Catalog(Box::new(State {
            request,
            surface: Surface::Workspace,
            selected_session: Some(SESSION.into()),
            ..State::default()
        })))
        .unwrap();
    events
        .send(Incoming::Handoff(Event::Open {
            version: 1,
            id: ID.into(),
            request,
            live_session_id: SESSION.into(),
            capability: Box::new(handoff(port)),
        }))
        .unwrap();
}
impl Loop {
    fn start() -> Self {
        Self::start_with(Script::default())
    }
    fn start_with(script: Script) -> Self {
        let (seen_tx, seen) = mpsc::channel();
        let port = listen(&seen_tx, script);
        let (events, receiver) = mpsc::sync_channel(8);
        let gate = Arc::new(AtomicBool::new(false));
        let (opened_tx, opened) = mpsc::channel::<()>();
        let held = gate.clone();
        let passed_on = Arc::new(AtomicU64::new(0));
        let presence = passed_on.clone();
        let bridge = start_events(Default::default(), receiver, true, move || {
            move |command| {
                if let Command::Presence { revision, .. } = command {
                    presence.store(revision, Ordering::SeqCst);
                    if held.swap(false, Ordering::SeqCst) {
                        let _ = opened.recv_timeout(Duration::from_secs(5));
                    }
                }
                Ok(())
            }
        });
        open(&events, 3, port);
        let mut running = Self {
            bridge,
            seen,
            gate,
            open: opened_tx,
            events,
            seen_tx,
            passed_on,
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
    /// The catalog re-issues the route as `request`, on a new stream.
    fn reopen(&self, request: u64) {
        open(
            &self.events,
            request,
            listen(&self.seen_tx, Script::default()),
        );
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

/// A window fit queued before the focus loss, or refused after it, is not a
/// lost key: no notice.
#[test]
fn a_fit_dropped_with_the_focus_loss_says_nothing() {
    let mut app = Loop::start();
    let fit = || Command::Input {
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
    app.one_turn(0, vec![fit(), focus(false, 1), fit()]);
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

/// Typing is text, a key, bytes or a paste; a fit, a pointer event, a wheel
/// step or a history scroll is not.
#[test]
fn only_typing_counts_as_keys_not_sent() {
    let cases = [
        (Input::Text("a".into()), true),
        (Input::Key("Enter".into()), true),
        (Input::Bytes("1b".into()), true),
        (Input::Paste("a".into()), true),
        (wheel(), false),
        (Input::Scroll(-1), false),
        (
            Input::Mouse(crate::tmux_snapshot::pointer::Command::Cancel { gesture: 1 }),
            false,
        ),
    ];
    for (input, typing) in cases {
        let label = format!("{input:?}");
        let command = Command::Input {
            request: 3,
            id: "left".into(),
            input_target: None,
            input,
        };
        assert_eq!(super::typed(&command), typing, "{label}");
    }
    assert!(!super::typed(&focus(false, 1)));
}

fn text(typed: &str) -> Command {
    Command::Input {
        request: 3,
        id: "left".into(),
        input_target: None,
        input: Input::Text(typed.into()),
    }
}
fn fit() -> Command {
    Command::Input {
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
    }
}
/// Waits for the window back with input and the notice, for up to 5 s: once
/// the stream is new, the notice reaches it one turn after the window is back.
fn noticed(app: &mut Loop, request: u64, revision: u64, what: &str) -> State {
    app.until(what, |state| {
        state.request == request
            && state.presence_revision == revision
            && state.input_ready
            && state.status == NOTICE
    })
}

/// Review round 1, item 1: the link drops while the window is away, after
/// the focus loss dropped a line. The catalog re-issues the stream, and the
/// window, back on the new stream, still says the line was not sent. The line
/// is never sent, on either stream.
#[test]
fn a_line_dropped_at_the_focus_loss_is_announced_after_a_reconnect_in_the_background() {
    let mut app = Loop::start_with(Script {
        close_on_release: true,
        ..Script::default()
    });
    let mut commands = line(4402);
    commands.push(focus(false, 1));
    app.one_turn(0, commands);
    app.until("the stream lost in the background", |state| {
        state.reconnect_attempt.is_some()
    });
    app.reopen(4);
    app.until("the new stream in the background", |state| {
        state.request == 4 && state.frame.is_some() && !state.retained_preview
    });
    app.send(focus(true, 2));
    noticed(
        &mut app,
        4,
        2,
        "line 4402, dropped at the focus loss, announced after the reconnect",
    );
    thread::sleep(Duration::from_millis(100));
    assert!(
        app.typed().is_empty(),
        "a key was sent after the window left"
    );
}

/// Review round 1, item 2: in the loop, a key the input scheduler holds back
/// (eight earlier keys unanswered, a link's round trip) when the window
/// leaves. The focus loss cancels it; once back, the window says so, and the
/// key is never sent.
#[test]
fn a_key_held_back_by_the_scheduler_when_the_window_leaves_is_announced_in_the_loop() {
    let script = Script::default();
    script.hold_acks.store(true, Ordering::SeqCst);
    let mut app = Loop::start_with(script.clone());
    for n in 0..4 {
        for command in line(n) {
            app.send(command);
        }
    }
    app.send(text("held-back"));
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut sent = Vec::new();
    while sent.len() < 8 {
        sent.extend(app.typed());
        assert!(Instant::now() < deadline, "8 keys did not go out: {sent:?}");
        thread::sleep(Duration::from_millis(2));
    }
    // Give the loop time to admit the ninth key: the scheduler holds it back.
    thread::sleep(Duration::from_millis(100));
    app.send(focus(false, 1));
    // The loop has taken the focus loss; the stream gives input up only once
    // the eight keys are answered, so answer them now.
    let deadline = Instant::now() + Duration::from_secs(5);
    while app.passed_on.load(Ordering::SeqCst) != 1 {
        assert!(Instant::now() < deadline, "the focus loss was not taken");
        thread::sleep(Duration::from_millis(2));
    }
    script.hold_acks.store(false, Ordering::SeqCst);
    app.until("the window in the background", |state| {
        state.presence_revision == 1
    });
    app.send(focus(true, 2));
    noticed(&mut app, 3, 2, "the held-back key announced as not sent");
    thread::sleep(Duration::from_millis(100));
    sent.extend(app.typed());
    assert_eq!(sent.len(), 8, "{sent:?}");
    assert!(
        sent.iter().all(|input| !input.contains("held-back")),
        "the held-back key was sent after the window left"
    );
}

/// Review round 1, item 3: the soak's own drain, a fit queued with the line.
/// With the fit first or last, the line is still announced.
#[test]
fn a_line_queued_with_a_fit_before_or_after_it_is_announced() {
    let orders: [fn() -> Vec<Command>; 2] = [
        || {
            let mut commands = vec![fit()];
            commands.extend(line(4402));
            commands.push(focus(false, 1));
            commands
        },
        || {
            let mut commands = line(4402);
            commands.push(fit());
            commands.push(focus(false, 1));
            commands
        },
    ];
    for (index, order) in orders.into_iter().enumerate() {
        let mut app = Loop::start();
        app.one_turn(0, order());
        app.until("the window in the background", |state| {
            state.presence_revision == 1
        });
        app.send(focus(true, 2));
        let back = app.until("the window back with input", |state| {
            state.presence_revision == 2 && state.input_ready
        });
        assert_eq!(
            back.status, NOTICE,
            "order {index} (0: fit first, 1: fit last)"
        );
        thread::sleep(Duration::from_millis(100));
        assert!(app.typed().is_empty(), "order {index}: a key was sent");
    }
}

/// A stream lost, or failed by a command, before the window is back to read
/// the notice hands it to the next stream; one with no notice, or another
/// outcome, hands nothing on.
#[test]
fn a_lost_stream_hands_keys_not_sent_to_the_next_stream() {
    let lost = || {
        NativeError::Controller(herdr_client::tmux_controller::Error::Transport(
            tmux_stream::Error::ReadyTimeout,
        ))
    };
    let other = Some("Pane action was not applied");
    let cases = [
        (Some(super::KEYS_NOT_SENT), false),
        (Some(super::KEYS_NOT_SENT), true),
        (None, false),
        (None, true),
        (other, false),
        (other, true),
    ];
    for (outcome, failed) in cases {
        let notice = outcome == Some(super::KEYS_NOT_SENT);
        let (mut active, state, _seen, peer) = selection_tests::fixture(true);
        active.action_status.set(outcome);
        let mut hold = hold::Hold::default();
        let mut pending = std::collections::VecDeque::new();
        if failed {
            super::command_failed(Some(&active), false, &mut pending, &mut hold, &state, 1);
        } else {
            super::stream_lost(&active, &mut pending, &mut hold, &state, 1, &lost());
        }
        assert_eq!(
            hold.take_keys_not_sent(),
            notice,
            "{outcome:?}, command failed {failed}"
        );
        active.controller.retire();
        peer.join().unwrap();
    }
}
