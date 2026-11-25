#![allow(clippy::unwrap_used)]
//! The terminal loop (`start_events`) on a scripted daemon stream on
//! loopback, for the tests of keys dropped without being sent (#875, #877).
//! No daemon, tmux or SSH is started.
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

pub(super) const GEN: &str = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
pub(super) const ID: &str = "b987f903-e864-43dd-8591-8d0a464ca6e8";
pub(super) const NONCE: &str = "f8da3f73-66c3-4621-bf6f-547ee1d5fd1c";
pub(super) const SESSION: &str = "live-session.01234567890123456789";
/// The words the window shows once it is back (#875).
pub(super) const NOTICE: &str =
    "Keys typed as the window lost focus were not sent. Type them again.";
// Base64 of the shared native compact seed vector (4 columns, 2 rows).
pub(super) const SEED: &str = "eyJmIjoicyIsImsiOiJ0ZXJtaW5hbC1zZW1hbnRpYy1jb21wYWN0IiwiciI6MSwicyI6WzQsMixbWzAsW1sxLCJBIiwxLDAsMCwwXSxbMSwiw6kiLDEsMCwwLDBdLFsxLCLnlYwiLDIsMCwwLDBdLFsxLCIiLDAsMCwwLDBdXV0sWzEsW1s0LCIgIiwxLDAsMCwwXV1dXSxbWzAsW1s0LCJoIiwxLDAsMCwwXV1dXSxbMiwxLDAsImJhciIsMV0sWzAsMSwwLDEsMCwwLDEsMSwiZHJhZyIsInNnciIsMF0sW1siaW1hZ2U6MSIsImtpdHR5IiwwLDAsMiwxLCJhYmMiXV0sWyJhdXRob3JpdGF0aXZlLXN0cmVhbSIsIm9ic2VydmVkLWZyb20tc3RhcnQiXV0sInYiOjF9";

/// How the scripted daemon departs from the plain one.
#[derive(Clone, Default)]
pub(super) struct Script {
    /// The stream closes when the app gives input up (the window left): a
    /// link that drops while the user is in another app.
    pub(super) close_on_release: bool,
    /// When the app gives input up, another client splits a pane in: the
    /// next layout names a pane the stream's lease lacks, so the route is
    /// re-leased.
    pub(super) add_pane_on_release: bool,
    /// While set, inputs are not answered: a link's round trip, so the input
    /// scheduler holds a ninth key back. Answered once cleared.
    pub(super) hold_acks: Arc<AtomicBool>,
    /// Once set, the stream closes: a link that dies while the loop is busy.
    pub(super) close_now: Arc<AtomicBool>,
    /// Set by the daemon once it has closed the stream.
    pub(super) closed: Arc<AtomicBool>,
    /// Geometry is granted too, as for an owner operation (a new window).
    pub(super) grant_geometry: bool,
    /// Once set, another client splits a pane in now (the route is re-leased);
    /// cleared by the daemon once the layout is out.
    pub(super) add_pane_now: Arc<AtomicBool>,
}

/// A daemon's pane stream: two panes, input granted on every request and
/// released on every release, every input answered. Each message the app
/// sends is passed on to `seen`.
pub(super) fn daemon(listener: TcpListener, seen: mpsc::Sender<Value>, script: Script) {
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
    let (mut input, mut geometry) = (false, false);
    // From here a read gives up after 20 ms, so held answers go out on time.
    socket
        .get_ref()
        .set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();
    let mut unanswered: Vec<Value> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if script.close_now.load(Ordering::SeqCst) {
            let _ = socket.close(None);
            let _ = socket.flush();
            script.closed.store(true, Ordering::SeqCst);
            return;
        }
        if script.add_pane_now.load(Ordering::SeqCst) {
            send(&mut socket, split_in());
            script.add_pane_now.store(false, Ordering::SeqCst);
        }
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
        let authority = value["authority"].as_str().unwrap_or_default().to_owned();
        let granted = kind == "authority-request"
            && (authority == "input" || (authority == "geometry" && script.grant_geometry));
        if granted || kind == "authority-release" {
            revision += 1;
            if authority == "geometry" {
                geometry = granted;
            } else {
                input = granted;
            }
            let owner = |held: bool| {
                if held {
                    json!("native.test")
                } else {
                    Value::Null
                }
            };
            let snapshot = json!({"generation":GEN,"session":"workspace","revision":revision,"owners":{"input":owner(input),"focus":null,"geometry":owner(geometry)},"nativeGeometryYieldUntilMs":0,"clients":[]});
            let receipt = if granted {
                json!({"type":"authority-receipt","requestId":value["requestId"],"authority":authority,"status":"granted","lease":{"generation":GEN,"session":"workspace","clientId":"native.test","authority":authority,"token":NONCE,"revision":revision},"snapshot":snapshot})
            } else {
                json!({"type":"authority-receipt","requestId":value["requestId"],"authority":value["authority"],"status":"released","snapshot":snapshot})
            };
            send(&mut socket, receipt);
            if script.add_pane_on_release && !granted && value["authority"] == "input" {
                send(&mut socket, split_in());
            }
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

/// The layout once another client has split pane `extra` in: a pane the
/// stream's lease lacks.
fn split_in() -> Value {
    json!({"type":"layout","semanticWindowId":"window","currentWindow":true,"cols":9,"rows":2,"zoomed":false,"paneBorderStatus":"off","panes":[{"pane":"left","left":0,"top":0,"width":4,"height":2,"active":true},{"pane":"right","left":5,"top":0,"width":2,"height":2,"active":false},{"pane":"extra","left":8,"top":0,"width":1,"height":2,"active":false}]})
}

pub(super) fn handoff(port: u16) -> Handoff {
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
pub(super) struct Loop {
    pub(super) bridge: Bridge,
    pub(super) seen: mpsc::Receiver<Value>,
    pub(super) gate: Arc<AtomicBool>,
    pub(super) open: mpsc::Sender<()>,
    pub(super) events: mpsc::SyncSender<Incoming>,
    pub(super) seen_tx: mpsc::Sender<Value>,
    /// The revision of the last focus change the loop passed on.
    pub(super) passed_on: Arc<AtomicU64>,
    /// How many times the loop asked the catalog to re-issue its route.
    pub(super) refreshes: Arc<AtomicU64>,
    /// How many owner operations (a new window, a new agent) the loop sent.
    pub(super) owner_actions: Arc<AtomicU64>,
}
/// A scripted daemon on a fresh loopback port.
pub(super) fn listen(seen: &mpsc::Sender<Value>, script: Script) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = seen.clone();
    thread::spawn(move || daemon(listener, seen, script));
    port
}
/// The catalog's open of request `request` on `port`.
pub(super) fn open(events: &mpsc::SyncSender<Incoming>, request: u64, port: u16) {
    open_session(events, request, port, SESSION);
}
/// The catalog's open of request `request` on `port`, for `session`.
pub(super) fn open_session(
    events: &mpsc::SyncSender<Incoming>,
    request: u64,
    port: u16,
    session: &str,
) {
    events
        .send(Incoming::Catalog(Box::new(State {
            request,
            surface: Surface::Workspace,
            selected_session: Some(session.into()),
            ..State::default()
        })))
        .unwrap();
    events
        .send(Incoming::Handoff(Event::Open {
            version: 1,
            id: ID.into(),
            request,
            live_session_id: session.into(),
            capability: Box::new(handoff(port)),
        }))
        .unwrap();
}
impl Loop {
    pub(super) fn start() -> Self {
        Self::start_with(Script::default())
    }
    pub(super) fn start_with(script: Script) -> Self {
        let (seen_tx, seen) = mpsc::channel();
        let port = listen(&seen_tx, script);
        let (events, receiver) = mpsc::sync_channel(8);
        let gate = Arc::new(AtomicBool::new(false));
        let (opened_tx, opened) = mpsc::channel::<()>();
        let held = gate.clone();
        let passed_on = Arc::new(AtomicU64::new(0));
        let presence = passed_on.clone();
        let refreshes = Arc::new(AtomicU64::new(0));
        let refreshed = refreshes.clone();
        let owner_actions = Arc::new(AtomicU64::new(0));
        let owned = owner_actions.clone();
        let bridge = start_events(Default::default(), receiver, true, move || {
            move |command| {
                if matches!(command, Command::NativeTerminalRefresh { .. }) {
                    refreshed.fetch_add(1, Ordering::SeqCst);
                }
                if matches!(command, Command::NativeOwnerAction { .. }) {
                    owned.fetch_add(1, Ordering::SeqCst);
                }
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
            refreshes,
            owner_actions,
        };
        running.until("input ready", |state| state.input_ready);
        running
    }
    /// The next publication that `wanted` accepts, within 5 s.
    pub(super) fn until(&mut self, what: &str, wanted: impl Fn(&State) -> bool) -> State {
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
    pub(super) fn reopen(&self, request: u64) {
        self.reopen_session(request, SESSION);
    }
    /// The catalog opens `session` as `request`, on a new stream.
    pub(super) fn reopen_session(&self, request: u64, session: &str) {
        open_session(
            &self.events,
            request,
            listen(&self.seen_tx, Script::default()),
            session,
        );
    }
    pub(super) fn send(&self, command: Command) {
        self.bridge.commands.send(command).unwrap();
    }
    /// Sends `commands` so that the loop takes all of them in one turn: it is
    /// held on a focus change it already took until they are all queued.
    pub(super) fn one_turn(&self, revision: u64, commands: Vec<Command>) {
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
    pub(super) fn typed(&self) -> Vec<String> {
        self.seen
            .try_iter()
            .filter(|value| value["type"] == "input")
            .map(|value| value.to_string())
            .collect()
    }
}

pub(super) fn line(n: u64) -> Vec<Command> {
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
pub(super) fn focus(active: bool, revision: u64) -> Command {
    Command::Presence { active, revision }
}

pub(super) fn wheel() -> Input {
    Input::Wheel {
        lines: -1,
        row: 0,
        col: 0,
        shift: false,
        alt: false,
        control: false,
    }
}

pub(super) fn text(typed: &str) -> Command {
    Command::Input {
        request: 3,
        id: "left".into(),
        input_target: None,
        input: Input::Text(typed.into()),
    }
}
pub(super) fn fit() -> Command {
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
pub(super) fn noticed(app: &mut Loop, request: u64, revision: u64, what: &str) -> State {
    app.until(what, |state| {
        state.request == request
            && state.presence_revision == revision
            && state.input_ready
            && state.status == NOTICE
    })
}
/// Waits up to 5 s for `done`.
pub(super) fn wait(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "never happened: {what}");
        thread::sleep(Duration::from_millis(2));
    }
}
/// Holds the loop inside one turn, with the window in front, while
/// `commands` are queued and `during` runs; then lets the turn go on.
pub(super) fn in_one_turn(app: &Loop, commands: Vec<Command>, during: impl FnOnce()) {
    app.gate.store(true, Ordering::SeqCst);
    app.send(focus(true, 0));
    for command in commands {
        app.send(command);
    }
    during();
    app.open.send(()).unwrap();
}
