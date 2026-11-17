#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
use std::{
    io::{Cursor, Read, Write},
    net::TcpListener,
    os::unix::fs::OpenOptionsExt,
    sync::mpsc,
};

struct Fixture {
    _sandbox: super::super::tests::Sandbox,
    listener: TcpListener,
    source: CatalogSource,
    identity: Value,
}
fn fixture() -> Fixture {
    let sandbox = super::super::tests::Sandbox::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let path = sandbox.0.join("daemon.json");
    let record = json!({"pid":123,"port":listener.local_addr().unwrap().port(),"protocolVersion":4,
        "productVersion":"2.9.12","instanceId":"d9c81ebd-5785-45a3-9206-a2aa497d68fc",
        "startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"fixture-private"});
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap()
        .write_all(record.to_string().as_bytes())
        .unwrap();
    let identity = json!({"pid":123,"ok":true,"protocolVersion":4,"productVersion":"2.9.12",
        "instanceId":record["instanceId"],"startedAt":record["startedAt"]});
    Fixture {
        _sandbox: sandbox,
        listener,
        source: CatalogSource::Local(path),
        identity,
    }
}

/// The request head already read from a socket, then the socket itself.
struct Replay {
    head: Cursor<Vec<u8>>,
    socket: TcpStream,
}
impl Read for Replay {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.head.read(buf)?;
        if n > 0 { Ok(n) } else { self.socket.read(buf) }
    }
}
impl Write for Replay {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.socket.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.socket.flush()
    }
}

fn read_head(socket: &mut TcpStream) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        if socket.read_exact(&mut byte).is_err() {
            return None;
        }
        bytes.push(byte[0]);
        assert!(bytes.len() < 8192);
    }
    Some(bytes)
}
fn respond(socket: &mut TcpStream, body: &Value, close: bool) {
    let body = body.to_string();
    write!(
        socket,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n{body}",
        body.len(),
        if close { "close" } else { "keep-alive" }
    )
    .unwrap();
}

type Bridge = tungstenite::WebSocket<Replay>;
/// The test's bridge side, run once for the one upgrade.
type Handler = Arc<Mutex<Option<Box<dyn FnOnce(Bridge) + Send>>>>;

/// A daemon that answers identity proofs and the capabilities request, and
/// hands an upgrade on the bridge path to `bridge`. Every request line is
/// recorded.
fn daemon(
    listener: TcpListener,
    identity: Value,
    capabilities: Value,
    bridge: impl FnOnce(Bridge) + Send + 'static,
) -> (mpsc::Receiver<String>, thread::JoinHandle<()>) {
    let (requests, seen) = mpsc::channel::<String>();
    let bridge: Handler = Arc::new(Mutex::new(Some(Box::new(bridge))));
    let handle = thread::spawn(move || {
        let (done_tx, done) = mpsc::channel::<()>();
        listener.set_nonblocking(true).unwrap();
        loop {
            if done.try_recv().is_ok() {
                return;
            }
            let socket = match listener.accept() {
                Ok((socket, _)) => socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(error) => panic!("{error}"),
            };
            socket.set_nonblocking(false).unwrap();
            let (identity, capabilities) = (identity.clone(), capabilities.clone());
            let (requests, bridge, done_tx) = (requests.clone(), bridge.clone(), done_tx.clone());
            thread::spawn(move || {
                serve(
                    socket,
                    &identity,
                    &capabilities,
                    &requests,
                    &bridge,
                    &done_tx,
                );
            });
        }
    });
    (seen, handle)
}

// tungstenite requires its fixed HTTP ErrorResponse callback type.
#[allow(clippy::result_large_err)]
fn serve(
    mut socket: TcpStream,
    identity: &Value,
    capabilities: &Value,
    requests: &mpsc::Sender<String>,
    bridge: &Handler,
    done: &mpsc::Sender<()>,
) {
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    while let Some(head) = read_head(&mut socket) {
        let text = String::from_utf8(head.clone()).unwrap();
        let line = text.lines().next().unwrap_or_default().to_owned();
        let _ = requests.send(line.clone());
        let lower = text.to_ascii_lowercase();
        if line.starts_with("GET /identity ") {
            assert!(!lower.contains("authorization"));
            respond(&mut socket, identity, false);
        } else if line.starts_with("POST /api/v2/capabilities?remoteBridge=1 ") {
            let length = lower
                .lines()
                .find_map(|l| l.strip_prefix("content-length: "))
                .map_or(0, |n| n.trim().parse::<usize>().unwrap());
            let mut body = vec![0; length];
            socket.read_exact(&mut body).unwrap();
            assert_eq!(body, b"{}");
            respond(&mut socket, capabilities, true);
            return;
        } else if line.starts_with("GET /api/v2/bridge ") {
            let replay = Replay {
                head: Cursor::new(head),
                socket: socket.try_clone().unwrap(),
            };
            let ws = tungstenite::accept_hdr(
                replay,
                |request: &tungstenite::handshake::server::Request,
                 mut response: tungstenite::handshake::server::Response| {
                    assert_eq!(
                        request.headers().get("authorization").unwrap(),
                        "Bearer fixture-private"
                    );
                    assert_eq!(
                        request.headers().get("sec-websocket-protocol").unwrap(),
                        "tmux-ide-bridge-v1"
                    );
                    response.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        "tmux-ide-bridge-v1".parse().unwrap(),
                    );
                    Ok(response)
                },
            )
            .unwrap();
            let run = bridge.lock().unwrap().take().unwrap();
            run(ws);
            let _ = done.send(());
            return;
        } else {
            panic!("unexpected request {line}");
        }
    }
}

fn offer() -> Value {
    json!({"status":"ok","daemon":{},"capabilities":{"remoteBridge":
        {"version":1,"path":"/api/v2/bridge","features":["clipboard-write"]}}})
}

fn until<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out");
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn an_older_daemon_gets_no_bridge_connection() {
    let fixture = fixture();
    let old =
        json!({"status":"ok","daemon":{},"capabilities":{"appWindowMutation":{"available":true}}});
    let (requests, server) = daemon(fixture.listener, fixture.identity, old, |_| {
        panic!("an older daemon must not see a bridge upgrade")
    });
    let worker = RemoteBridgeWorker::spawn(fixture.source, || {}).unwrap();
    let end = until(|| worker.take_end());
    assert!(matches!(end, BridgeEnd::Unsupported), "{end:?}");
    assert!(worker.take_events().is_empty());
    assert!(!worker.live());
    drop(worker);
    let seen: Vec<String> = requests.try_iter().collect();
    assert!(
        seen.iter().all(|line| !line.contains("/api/v2/bridge")),
        "{seen:?}"
    );
    assert!(seen.iter().any(|line| line.contains("remoteBridge=1")));
    drop(server);
}

#[test]
fn copies_arrive_after_hello_and_ready() {
    let fixture = fixture();
    let (hello_tx, hello_rx) = mpsc::channel();
    let (_requests, server) = daemon(
        fixture.listener,
        fixture.identity,
        offer(),
        move |mut ws| {
            let hello = ws.read().unwrap();
            hello_tx.send(hello.to_text().unwrap().to_owned()).unwrap();
            let send = |ws: &mut Bridge, value: Value| {
                ws.send(Message::Text(value.to_string().into())).unwrap();
            };
            send(
                &mut ws,
                json!({"type":"ready","version":1,"features":["clipboard-write"]}),
            );
            send(&mut ws, json!({"type":"port.added","port":3000}));
            send(
                &mut ws,
                json!({"type":"clipboard.write","session":"s","paneId":"pane.mirror.ab",
            "incarnation":"g:0","bytes":2,"text":"hi"}),
            );
            send(
                &mut ws,
                json!({"type":"clipboard.refused","session":"s","paneId":"pane.mirror.ab",
            "incarnation":"g:0","bytes":3_000_000,"reason":"too-large"}),
            );
            // Hold the lane open until the client goes away.
            while ws.read().is_ok() {}
        },
    );
    let (woke_tx, woke) = mpsc::channel();
    let worker = RemoteBridgeWorker::spawn(fixture.source, move || {
        let _ = woke_tx.send(());
    })
    .unwrap();
    assert_eq!(
        hello_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        r#"{"type":"hello","version":1}"#
    );
    let mut events = Vec::new();
    until(|| {
        events.extend(worker.take_events());
        (events.len() >= 2).then_some(())
    });
    assert!(woke.try_recv().is_ok());
    assert!(worker.live());
    assert_eq!(
        events,
        vec![
            BridgeEvent::Clipboard {
                session: "s".into(),
                pane_id: "pane.mirror.ab".into(),
                incarnation: "g:0".into(),
                text: "hi".into(),
            },
            BridgeEvent::TooLarge {
                session: "s".into(),
                pane_id: "pane.mirror.ab".into(),
                incarnation: "g:0".into(),
                bytes: 3_000_000,
            },
        ]
    );
    worker.cancel();
    assert!(!worker.live());
    server.join().unwrap();
}

#[test]
fn a_report_before_ready_fails_the_lane() {
    let fixture = fixture();
    let (_requests, server) = daemon(fixture.listener, fixture.identity, offer(), |mut ws| {
        let _ = ws.read();
        ws.send(Message::Text(
            json!({"type":"clipboard.write","session":"s","paneId":"p","incarnation":"g:0",
                "bytes":2,"text":"hi"})
            .to_string()
            .into(),
        ))
        .unwrap();
        while ws.read().is_ok() {}
    });
    let worker = RemoteBridgeWorker::spawn(fixture.source, || {}).unwrap();
    let end = until(|| worker.take_end());
    assert!(
        matches!(end, BridgeEnd::Failed(RemoteBridgeError::Protocol(_))),
        "{end:?}"
    );
    assert!(worker.take_events().is_empty());
    server.join().unwrap();
}

#[test]
fn a_ready_for_another_version_fails_the_lane() {
    let fixture = fixture();
    let (_requests, server) = daemon(fixture.listener, fixture.identity, offer(), |mut ws| {
        let _ = ws.read();
        ws.send(Message::Text(
            json!({"type":"ready","version":2,"features":["clipboard-write"]})
                .to_string()
                .into(),
        ))
        .unwrap();
        while ws.read().is_ok() {}
    });
    let worker = RemoteBridgeWorker::spawn(fixture.source, || {}).unwrap();
    let end = until(|| worker.take_end());
    assert!(
        matches!(
            end,
            BridgeEnd::Failed(RemoteBridgeError::Protocol(WireError::Version))
        ),
        "{end:?}"
    );
    server.join().unwrap();
}

/// Cross-checks this lane against a real daemon. Needs a private daemon and
/// tmux server (never the owner's): its daemon.json, the tmux binary, the -S
/// socket and a pane target that runs a shell.
#[test]
#[ignore = "needs a private daemon: TMUX_IDE_BRIDGE_LIVE_{RECORD,TMUX,SOCKET,TARGET}"]
fn a_live_daemon_reports_a_copy() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} unset"));
    let (tmux, socket, target) = (
        var("TMUX_IDE_BRIDGE_LIVE_TMUX"),
        var("TMUX_IDE_BRIDGE_LIVE_SOCKET"),
        var("TMUX_IDE_BRIDGE_LIVE_TARGET"),
    );
    assert!(!socket.starts_with("/private/tmp/tmux-") && !socket.starts_with("/tmp/tmux-"));
    let source = CatalogSource::Local(var("TMUX_IDE_BRIDGE_LIVE_RECORD").into());
    let worker = RemoteBridgeWorker::spawn(source, || {}).unwrap();
    until(|| worker.live().then_some(()));
    let send = |keys: &[&str]| {
        let status = std::process::Command::new(&tmux)
            .args(["-S", &socket, "send-keys", "-t", &target])
            .args(keys)
            .status()
            .unwrap();
        assert!(status.success());
    };
    let mut latencies = Vec::new();
    for run in 0..5 {
        let text = format!("live-{run}");
        send(&[
            "-l",
            &format!("printf '\\033]52;c;%s\\007' \"$(printf {text} | base64)\""),
        ]);
        let start = Instant::now();
        send(&["Enter"]);
        let event = until(|| worker.take_events().into_iter().next());
        latencies.push(start.elapsed());
        match event {
            BridgeEvent::Clipboard { text: got, .. } => assert_eq!(got, text),
            other => panic!("unexpected {other:?}"),
        }
        thread::sleep(Duration::from_millis(300));
    }
    eprintln!("live bridge Enter-to-event latencies: {latencies:?}");
    assert!(worker.take_end().is_none());
}

/// A released daemon without the bridge: the lane ends as unsupported and
/// never upgrades. Needs a private daemon's daemon.json.
#[test]
#[ignore = "needs a private older daemon: TMUX_IDE_BRIDGE_LIVE_RECORD"]
fn a_live_older_daemon_gets_no_lane() {
    let record = std::env::var("TMUX_IDE_BRIDGE_LIVE_RECORD").unwrap();
    let worker = RemoteBridgeWorker::spawn(CatalogSource::Local(record.into()), || {}).unwrap();
    let end = until(|| worker.take_end());
    assert!(matches!(end, BridgeEnd::Unsupported), "{end:?}");
    assert!(!worker.live());
}
