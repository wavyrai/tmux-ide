//! Card #871: the terminal loop outlives a stream it cannot use. Soak, 23 Nov
//! 2026: another client's detach closed the pane stream, the window went to
//! the background 10 ms later, and the loop ended with no error line. Each
//! test here runs the whole loop (`start_events`) against a scripted daemon.
use super::*;
use crate::tmux_snapshot::browser::Bridge;
use herdr_client::tmux_handoff::Event;

const ROUTE_B: &str = "7c1f0a52-3b7e-4d0a-9a53-0d6a3f1c2b11";
const SESSION: &str = "live-session.01234567890123456789";
const WAIT: Duration = Duration::from_secs(5);
/// The marker command whose delivery stops the loop between two polls.
const GATE: u64 = 77;

struct Peer {
    port: u16,
    stop: mpsc::Sender<()>,
    done: mpsc::Receiver<()>,
}
/// A daemon that serves one stream with two panes, grants input, and drops
/// the socket with no close frame when told to stop.
fn peer() -> Peer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (stop, stopped) = mpsc::channel::<()>();
    let (finished, done) = mpsc::channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(10)))
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
        let text = |value: Value| tungstenite::Message::Text(value.to_string().into());
        let mut ready = false;
        loop {
            if !matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                break;
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
            if !ready {
                ready = true;
                socket.send(text(json!({"type":"ready","protocolVersion":2,"daemonInstanceId":GEN,"requestId":ID,"panes":["left","right"],"effectiveViewerMode":"interactive","connectionClientId":"native.test","inputLifetime":true}))).unwrap();
                let vectors: Vec<Value> = serde_json::from_str(include_str!(
                    "../../../herdr-client/src/tmux_delivery/tests/vectors.json"
                ))
                .unwrap();
                let vector = &vectors[0];
                for pane in ["left", "right"] {
                    socket.send(text(json!({"type":"terminal-delivery-ready","pane":pane,"negotiation":{"accepted":true,"negotiated":{"protocolVersion":1,"encoding":"semantic-compact-v1","richPlacements":true,"generation":GEN,"deliveryNonce":NONCE}}}))).unwrap();
                    socket.send(text(json!({"type":"terminal-delivery-envelope","pane":pane,"envelope":{"type":"terminal.delivery","workspaceName":"workspace","semanticPaneId":pane,"generation":GEN,"incarnation":format!("birth-{pane}"),"deliveryNonce":NONCE,"transactionId":ID,"protocolVersion":1,"encoding":"semantic-compact-v1","frame":"seed","baseRevision":null,"canonicalRevision":1,"canonicalStateHash":vector["canonicalHash"],"representationHash":vector["representationHash"],"representationBytes":vector["wire"].as_str().unwrap().len(),"chunkCount":1,"canonicalEquivalent":true,"history":"complete","richPlacements":true}}))).unwrap();
                    socket.send(text(json!({"type":"terminal-delivery-chunk","pane":pane,"transactionId":ID,"index":0,"data":SEED}))).unwrap();
                }
                socket.send(text(json!({"type":"layout","semanticWindowId":"window","currentWindow":true,"cols":9,"rows":2,"zoomed":false,"paneBorderStatus":"off","panes":[{"pane":"left","left":0,"top":0,"width":4,"height":2,"active":true},{"pane":"right","left":5,"top":0,"width":4,"height":2,"active":false}]}))).unwrap();
                continue;
            }
            let tungstenite::Message::Text(body) = message else {
                if message.is_close() {
                    break;
                }
                continue;
            };
            let value: Value = serde_json::from_str(&body).unwrap();
            if value["type"] == "authority-request" && value["authority"] == "input" {
                let authority = json!({"generation":GEN,"session":"workspace","revision":1,"owners":{"input":"native.test","focus":null,"geometry":null},"nativeGeometryYieldUntilMs":0,"clients":[]});
                let _ = socket.send(text(json!({"type":"authority-receipt","requestId":value["requestId"],"authority":"input","status":"granted","lease":{"generation":GEN,"session":"workspace","clientId":"native.test","authority":"input","token":NONCE,"revision":1},"snapshot":authority})));
            }
        }
        drop(socket);
        let _ = finished.send(());
    });
    Peer { port, stop, done }
}
impl Peer {
    /// Ends the stream as a dead daemon does, and waits until it is gone.
    fn die(&self) {
        let _ = self.stop.send(());
        self.done.recv_timeout(WAIT).unwrap();
        // The stream's own threads read the closed socket.
        thread::sleep(Duration::from_millis(300));
    }
}
fn capability(port: u16, expires_in_ms: i64) -> Box<Handoff> {
    let now = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    Box::new(Handoff::parse(&serde_json::to_vec(&json!({"descriptor":{"protocolVersion":2,"webSocketUrl":format!("ws://127.0.0.1:{port}/v2/terminal/pane-streams/redeem"),"subprotocol":tmux_stream::SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":GEN,"requestId":ID,"expiresAt":now + expires_in_ms,"panes":["left","right"],"effectiveViewerMode":"interactive"},"origin":"http://127.0.0.1:4000","hostClientId":"native.test","workspaceName":"workspace","selectedPane":"left"})).unwrap()).unwrap())
}
fn open(id: &str, capability: Box<Handoff>) -> Incoming {
    Incoming::Handoff(Event::Open {
        version: 1,
        id: id.into(),
        request: 3,
        live_session_id: SESSION.into(),
        capability,
    })
}

struct Worker {
    bridge: Bridge,
    events: mpsc::SyncSender<Incoming>,
    /// Every command the loop passed to its owner, in order.
    out: mpsc::Receiver<Command>,
    entered: mpsc::Receiver<()>,
    gate: mpsc::Sender<()>,
}
fn worker() -> Worker {
    let (events, receiver) = mpsc::sync_channel(8);
    let (forward, out) = mpsc::channel();
    let (enter, entered) = mpsc::channel();
    let (gate, opened) = mpsc::channel::<()>();
    let bridge = start_events(Default::default(), receiver, true, move || {
        move |command| {
            if matches!(command, Command::BrowserControls { request: GATE, .. }) {
                let _ = enter.send(());
                let _ = opened.recv_timeout(WAIT * 2);
            }
            let _ = forward.send(command);
            Ok(())
        }
    });
    events
        .send(Incoming::Catalog(Box::new(State {
            request: 3,
            selected_session: Some(SESSION.into()),
            ..State::default()
        })))
        .unwrap();
    Worker {
        bridge,
        events,
        out,
        entered,
        gate,
    }
}
impl Worker {
    /// The next publication. Panics when the loop has ended.
    fn published(&self) -> Option<State> {
        let next = self.bridge.mailbox.lock().unwrap().take();
        next.map(|state| state.unwrap_or_else(|| panic!("the terminal loop ended")))
    }
    fn until_input_ready(&self) {
        let deadline = Instant::now() + WAIT;
        loop {
            if self.published().is_some_and(|state| state.input_ready) {
                return;
            }
            assert!(Instant::now() < deadline, "the stream never took input");
            thread::sleep(Duration::from_millis(2));
        }
    }
    /// Stops the loop inside its owner's command sink: no poll runs until
    /// [`Self::resume`], so a stream that dies meanwhile is dead but not yet
    /// seen by the loop.
    fn pause(&self) {
        self.bridge
            .commands
            .send(Command::BrowserControls {
                request: GATE,
                id: "left".into(),
                command: None,
            })
            .unwrap();
        self.entered.recv_timeout(WAIT).unwrap();
    }
    fn resume(&self) {
        self.gate.send(()).unwrap();
    }
    /// Commands passed on until `wanted` matches one. Panics when the loop
    /// ends first.
    fn until(&self, what: &str, wanted: impl Fn(&Command) -> bool) -> Vec<Command> {
        let deadline = Instant::now() + WAIT;
        let mut seen = Vec::new();
        loop {
            self.published();
            match self.out.recv_timeout(Duration::from_millis(20)) {
                Ok(command) => {
                    let found = wanted(&command);
                    seen.push(command);
                    if found {
                        return seen;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("the terminal loop ended before: {what}")
                }
            }
            assert!(Instant::now() < deadline, "never happened: {what}");
        }
    }
    /// The loop still takes a command and passes it on.
    fn assert_alive(&self) {
        self.bridge
            .commands
            .send(Command::Refresh { request: 99 })
            .unwrap();
        self.until("a later command is passed on", |command| {
            matches!(command, Command::Refresh { request: 99 })
        });
        self.published();
    }
}
fn interrupted(command: &Command) -> bool {
    matches!(
        command,
        Command::NativeTerminalInterrupted { request: 3, .. }
    )
}

/// The soak's sequence, for a window that leaves and one that returns: the
/// stream is dead, the loop has not polled it yet, and the focus change
/// arrives. The loop reports the stream lost so the catalog re-issues it, and
/// passes the focus change on.
#[test]
fn a_focus_change_on_a_dead_stream_reconnects_and_keeps_the_loop() {
    for foreground in [false, true] {
        let peer = peer();
        let worker = worker();
        worker
            .events
            .send(open(ID, capability(peer.port, 30_000)))
            .unwrap();
        worker.until_input_ready();
        worker.pause();
        peer.die();
        worker
            .bridge
            .commands
            .send(Command::Presence {
                active: foreground,
                revision: 1,
            })
            .unwrap();
        worker.resume();
        let seen = worker.until("the lost stream is reported", interrupted);
        assert!(
            seen.iter().any(|command| matches!(
                command,
                Command::Presence { active, revision: 1 } if *active == foreground
            )),
            "the focus change was not passed on (foreground: {foreground})"
        );
        assert!(
            seen.iter().any(|command| matches!(
                command,
                Command::NativeTerminalInterrupted {
                    id,
                    request: 3,
                    presence_revision: 1,
                    ..
                } if id == ID
            )),
            "the notice does not name the route and the focus revision"
        );
        worker.assert_alive();
    }
}

/// A focus change the stream refuses (here: out of order) is not the end of
/// the loop either. The stream is retired, so a window that left can never
/// keep a stream that still takes input, and the catalog re-issues it.
#[test]
fn a_refused_focus_change_retires_the_stream_and_keeps_the_loop() {
    let peer = peer();
    let worker = worker();
    worker
        .events
        .send(open(ID, capability(peer.port, 30_000)))
        .unwrap();
    worker.until_input_ready();
    // Revision 0 was foreground: background at the same revision is refused.
    worker
        .bridge
        .commands
        .send(Command::Presence {
            active: false,
            revision: 0,
        })
        .unwrap();
    worker.until("the refused stream is reported", interrupted);
    peer.done
        .recv_timeout(WAIT)
        .expect("the refused stream stayed open");
    worker.assert_alive();
}

/// A stream that cannot be opened (its one-use capability expired on the way:
/// the Mac slept, or the loop was held up) is reported lost for the catalog to
/// re-issue. It does not end the loop.
#[test]
fn a_stream_that_cannot_be_opened_is_reported_and_keeps_the_loop() {
    let worker = worker();
    worker
        .bridge
        .commands
        .send(Command::Presence {
            active: true,
            revision: 4,
        })
        .unwrap();
    worker.until("the focus change is passed on", |command| {
        matches!(command, Command::Presence { revision: 4, .. })
    });
    worker.events.send(open(ID, capability(9, -1))).unwrap();
    let seen = worker.until("the failed open is reported", interrupted);
    assert!(
        matches!(
            seen.last(),
            Some(Command::NativeTerminalInterrupted {
                id,
                pane,
                live_session_id,
                generation,
                presence_revision: 4,
                ..
            }) if id == ID && pane == "left" && live_session_id == SESSION && generation == GEN
        ),
        "the notice does not name the route the catalog opened"
    );
    worker.assert_alive();
}

/// The catalog owns routes. A close can miss the loop's route (a pane
/// selection moved its request on before the catalog heard of it), and the
/// next open then finds the old route still there. The loop retires the old
/// stream and takes the new one.
#[test]
fn an_open_over_a_route_the_close_missed_replaces_it() {
    let first = peer();
    let second = peer();
    let worker = worker();
    worker
        .events
        .send(open(ID, capability(first.port, 30_000)))
        .unwrap();
    worker.until_input_ready();
    worker
        .events
        .send(open(ROUTE_B, capability(second.port, 30_000)))
        .unwrap();
    first
        .done
        .recv_timeout(WAIT)
        .expect("the replaced stream stayed open");
    worker.until_input_ready();
    worker.assert_alive();
    // An open older than the catalog the loop holds is still refused.
    worker
        .events
        .send(Incoming::Catalog(Box::new(State {
            request: 5,
            ..State::default()
        })))
        .unwrap();
    worker.events.send(open(ID, capability(9, 30_000))).unwrap();
    let deadline = Instant::now() + WAIT;
    loop {
        let next = worker.bridge.mailbox.lock().unwrap().take();
        if matches!(next, Some(None)) {
            break;
        }
        assert!(Instant::now() < deadline, "a stale open was accepted");
        thread::sleep(Duration::from_millis(2));
    }
}
