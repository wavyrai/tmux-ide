//! attach-rtt: a session opens over SSH in as few round trips as the daemon
//! allows, and a pause longer than the daemon's idle timeout costs no failure.
#![allow(clippy::unwrap_used, clippy::type_complexity)]
use super::*;
use crate::{
    tmux_daemon::{ServerClient, TerminalSelection},
    tmux_handoff::ServerScope,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
};
const INSTANCE: &str = "d9c81ebd-5785-45a3-9206-a2aa497d68fc";
const LIVE: &str = "live-session.0123456789abcdef0123";

/// One request line and body, or `None` when the client closed or stayed
/// silent for `idle` (the peer then closes, as Node does after keepAliveTimeout).
fn request(stream: &mut TcpStream, idle: Duration) -> Option<(String, Vec<u8>)> {
    request_with_headers(stream, idle).map(|(line, _, body)| (line, body))
}
fn request_with_headers(
    stream: &mut TcpStream,
    idle: Duration,
) -> Option<(String, HashMap<String, String>, Vec<u8>)> {
    stream.set_read_timeout(Some(idle)).unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(1) => bytes.push(byte[0]),
            Ok(_) => return None,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return None;
            }
            Err(error) => panic!("{error}"),
        }
    }
    let head = String::from_utf8(bytes).unwrap();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap().to_owned();
    let headers: HashMap<_, _> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length = headers
        .get("content-length")
        .map_or(0, |v| v.parse::<usize>().unwrap());
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    Some((first, headers, body))
}
fn reply(stream: &mut TcpStream, status: u16, body: &Value) {
    let bytes = serde_json::to_vec(body).unwrap();
    write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\n\r\n",
        bytes.len()
    )
    .unwrap();
    stream.write_all(&bytes).unwrap();
}
fn scope() -> ServerScope {
    ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: INSTANCE.into(),
    }
}
fn identity(version: &str) -> Value {
    json!({"ok":true,"pid":123,"protocolVersion":4,"productVersion":version,"instanceId":INSTANCE,"startedAt":"2026-10-25T02:00:00Z"})
}
/// A scripted daemon: every accepted connection proves `/identity` first,
/// then each request is answered by `answer` until the client goes quiet for
/// `idle`. Every request line is reported, connection by connection.
fn daemon(
    version: &'static str,
    idle: Duration,
    answer: impl Fn(&str, &[u8]) -> (u16, Value) + Send + Sync + 'static,
) -> (
    u16,
    crate::tmux_ssh::RemoteDescriptor,
    mpsc::Receiver<(usize, String)>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut record = identity(version);
    record.as_object_mut().unwrap().remove("ok");
    record["port"] = 4111.into();
    record["bindHostname"] = "127.0.0.1".into();
    record["authToken"] = "secret-fixture".into();
    let descriptor = crate::tmux_ssh::RemoteDescriptor::parse(
        &serde_json::to_vec(&json!({"version":1,"daemon":record})).unwrap(),
        None,
    )
    .unwrap();
    let (seen, requests) = mpsc::channel();
    let answer = Arc::new(answer);
    thread::spawn(move || {
        // One thread per connection: the stream's socket is proven while the
        // HTTP lane's connection is still open.
        for (index, stream) in listener.incoming().enumerate() {
            let mut stream = stream.unwrap();
            let (seen, answer) = (seen.clone(), Arc::clone(&answer));
            thread::spawn(move || {
                while let Some((line, body)) = request(&mut stream, idle) {
                    let _ = seen.send((index, line.clone()));
                    if line.starts_with("GET /identity ") {
                        reply(&mut stream, 200, &identity(version));
                    } else {
                        let (status, value) = answer(&line, &body);
                        reply(&mut stream, status, &value);
                    }
                }
            });
        }
    });
    (port, descriptor, requests)
}
/// A client on a fixture route that ends the route's forward when dropped,
/// so no fixture forward outlives its test (the tunnel tests look for them).
struct Remote {
    client: Option<ServerClient>,
    route: Option<Arc<crate::tmux_ssh::RemoteTransport>>,
}
impl Remote {
    fn new(route: Arc<crate::tmux_ssh::RemoteTransport>) -> Self {
        let client = Owner::Remote(route.clone())
            .select_server(&scope())
            .unwrap();
        Self {
            client: Some(client),
            route: Some(route),
        }
    }
}
impl std::ops::Deref for Remote {
    type Target = ServerClient;
    fn deref(&self) -> &ServerClient {
        self.client.as_ref().unwrap()
    }
}
impl Drop for Remote {
    fn drop(&mut self) {
        drop(self.client.take());
        if let Some(Ok(route)) = self.route.take().map(Arc::try_unwrap) {
            let _ = route.shutdown_fixture();
        }
    }
}
fn servers() -> Value {
    let scope = scope();
    json!({"version":1,"servers":[{"state":"online","serverId":scope.server_id,"label":"Remote","generation":INSTANCE}]})
}
fn opened() -> Value {
    let scope = scope();
    json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"workspaceName":"fixture","liveSessionId":LIVE})
}
fn inventory() -> Value {
    let scope = scope();
    json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"resource":{"workspaceName":"fixture","workspaceId":"workspace.fixture","sessionId":"session.0123456789abcdef","resourceRevision":1,"semanticPaneIds":["pane.first"]}})
}
fn sessions(listed: bool) -> Value {
    let scope = scope();
    let rows = if listed {
        json!([{"liveSessionId":LIVE,"sessionName":"fixture","workspaceName":"fixture","paneCount":1,"windowCount":1,"lastActivity":null,"favicon":null}])
    } else {
        json!([])
    };
    json!({"version":2,"server":{"serverId":scope.server_id,"generation":scope.generation},"sessions":rows})
}
fn route_answer(line: &str) -> (u16, Value) {
    if line.starts_with("GET /api/v1/tmux-servers ") {
        (200, servers())
    } else if line.contains("/sessions/") && line.ends_with("/open HTTP/1.1") {
        (200, opened())
    } else if line.contains("/inventory/") {
        (200, inventory())
    } else {
        (500, json!({}))
    }
}
fn drained(requests: &mpsc::Receiver<(usize, String)>) -> Vec<(usize, String)> {
    let mut seen = Vec::new();
    while let Ok(entry) = requests.recv_timeout(Duration::from_millis(200)) {
        seen.push(entry);
    }
    seen
}
fn path(line: &str) -> &str {
    line.split(' ').nth(1).unwrap()
}

#[test]
fn opening_sends_one_open_and_one_fenced_inventory_read_and_no_catalog_reads() {
    let (port, descriptor, requests) = daemon("2.9.12", Duration::from_secs(5), |line, _| {
        route_answer(line)
    });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    let client = Remote::new(route);
    drained(&requests);
    let workspace = client.open_session(LIVE).unwrap();
    let panes = client.workspace_inventory(LIVE, &workspace).unwrap().panes;
    assert_eq!(
        (workspace.as_str(), panes),
        ("fixture", vec!["pane.first".to_owned()])
    );
    let seen = drained(&requests);
    let scope = scope();
    let prefix = format!("/api/v1/tmux-servers/{}/{}", scope.server_id, INSTANCE);
    assert_eq!(
        seen.iter().map(|(_, line)| path(line)).collect::<Vec<_>>(),
        [
            format!("{prefix}/sessions/{LIVE}/open"),
            format!("{prefix}/inventory/fixture?liveSessionId={LIVE}"),
        ]
    );
}

#[test]
fn a_refused_open_reads_the_catalog_once_to_tell_a_vanished_session() {
    for (listed, status, gone) in [(false, 503, true), (true, 503, false), (true, 409, true)] {
        let (port, descriptor, requests) =
            daemon("2.9.12", Duration::from_secs(5), move |line, _| {
                if line.contains("/open ") {
                    (status, json!({"error":{"code":"x"}}))
                } else if line.contains("/sessions?") {
                    (200, sessions(listed))
                } else {
                    route_answer(line)
                }
            });
        let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
        let client = Remote::new(route);
        drained(&requests);
        let error = client.open_session(LIVE).unwrap_err();
        assert_eq!(
            matches!(error, Error::ServerChanged),
            gone,
            "listed={listed} status={status}: {error:?}"
        );
        if !gone {
            assert!(matches!(error, Error::RequestStatus(503)));
        }
        let reads = drained(&requests)
            .into_iter()
            .filter(|(_, line)| line.contains("/sessions?"))
            .count();
        assert_eq!(reads, usize::from(status != 409));
    }
}

/// The owner's regression (18 Nov): open, wait longer than the daemon keeps
/// an idle connection (Node closes it after 5 s), open again. The second open
/// proves a new connection and succeeds; before, it failed without reaching
/// the daemon and the app showed "Reconnecting".
#[test]
fn an_open_after_the_daemon_closed_the_idle_connection_succeeds_on_a_new_proven_one() {
    let (port, descriptor, requests) = daemon("2.9.26", Duration::from_secs(5), |line, _| {
        route_answer(line)
    });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    let client = Remote::new(route);
    assert_eq!(client.open_session(LIVE).unwrap(), "fixture");
    thread::sleep(Duration::from_millis(5_500));
    assert_eq!(client.open_session(LIVE).unwrap(), "fixture");
    let seen = drained(&requests);
    let (last, line) = seen.last().unwrap();
    assert!(line.contains("/open "), "{seen:?}");
    // The second open went out once, on a new connection that proved the
    // daemon's identity before it.
    let on_last: Vec<_> = seen.iter().filter(|(i, _)| i == last).collect();
    assert_eq!(on_last.len(), 2, "{seen:?}");
    assert!(on_last[0].1.starts_with("GET /identity "));
    assert_eq!(seen.iter().filter(|(_, l)| l.contains("/open ")).count(), 2);
}

fn issued(request_id: &Value, panes: &Value) -> Value {
    json!({"status":"issued","descriptor":{"protocolVersion":2,"webSocketUrl":"ws://127.0.0.1:4111/v2/terminal/pane-streams/redeem","subprotocol":crate::tmux_stream::SUBPROTOCOL,"redemptionTicket":format!("ps2_{}","a".repeat(43)),"daemonInstanceId":INSTANCE,"requestId":request_id,"expiresAt":9999999999999u64,"panes":panes,"effectiveViewerMode":"interactive"}})
}
fn attach_inventory() -> Value {
    json!({"workspaceName":"fixture","workspaceId":"workspace.fixture","sessionId":"session.0123456789abcdef","resourceRevision":1,"semanticPaneIds":["pane.a","pane.b"],"windows":[{"semanticWindowId":"window.one","active":true,"semanticPaneIds":["pane.a","pane.b"]}]})
}
/// A 2.9.27 daemon's attach answer, built by `shape` from the request body.
fn attaching(
    shape: impl Fn(&Value) -> Value + Send + Sync + 'static,
) -> (
    Arc<crate::tmux_ssh::RemoteTransport>,
    mpsc::Receiver<(usize, String)>,
    Arc<std::sync::Mutex<Vec<Value>>>,
) {
    let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
    let kept = Arc::clone(&bodies);
    let (port, descriptor, requests) =
        daemon("2.9.27", Duration::from_secs(5), move |line, body| {
            if line.contains("/attach ") {
                let body: Value = serde_json::from_slice(body).unwrap();
                kept.lock().unwrap().push(body.clone());
                (200, shape(&body))
            } else {
                route_answer(line)
            }
        });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    (route, requests, bodies)
}
fn answer(body: &Value, selection: Value, issue: Value) -> Value {
    let scope = scope();
    assert!(body["issue"]["requestId"].is_string());
    json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"workspaceName":"fixture","liveSessionId":LIVE,"inventory":attach_inventory(),"selection":selection,"issue":issue})
}

#[test]
fn a_daemon_that_attaches_opens_inventories_and_issues_in_one_request() {
    let (route, requests, bodies) = attaching(|body| {
        answer(
            body,
            json!({"semanticWindowId":null,"panes":["pane.a","pane.b"],"selectedPane":"pane.b"}),
            issued(&body["issue"]["requestId"], &json!(["pane.a", "pane.b"])),
        )
    });
    let client = Remote::new(route);
    drained(&requests);
    let attached = client.attach_session(LIVE, Some("pane.b"), 24).unwrap();
    assert_eq!(attached.workspace_name, "fixture");
    assert_eq!(attached.inventory.panes, ["pane.a", "pane.b"]);
    let stream = attached.stream.unwrap();
    assert_eq!((stream.window, stream.selected.as_str()), (None, "pane.b"));
    assert_eq!(stream.panes, ["pane.a", "pane.b"]);
    let handoff = &stream.handoff;
    assert_eq!(handoff.selected_pane, "pane.b");
    assert!(handoff.remote_peer.is_some() && handoff.local_images.is_none());
    assert!(handoff.upgrade.redeem_in_upgrade);
    assert!(handoff.upgrade.prepared.is_some());
    // One request on the HTTP lane; the stream's socket was proven on its own.
    let seen = drained(&requests);
    let lanes: Vec<_> = seen
        .iter()
        .filter(|(_, l)| !l.starts_with("GET /identity "))
        .collect();
    assert_eq!(lanes.len(), 1, "{seen:?}");
    assert!(lanes[0].1.contains(&format!("/sessions/{LIVE}/attach ")));
    assert!(
        seen.iter()
            .any(|(i, l)| *i != lanes[0].0 && l.starts_with("GET /identity "))
    );
    let body = bodies.lock().unwrap()[0].clone();
    assert_eq!(
        (
            body["version"].clone(),
            body["preferredPane"].clone(),
            body["maxPanes"].clone()
        ),
        (json!(1), json!("pane.b"), json!(24))
    );
    let stream_body = body["issue"]["stream"].as_object().unwrap();
    assert!(!stream_body.contains_key("workspaceName") && !stream_body.contains_key("panes"));
    // The attach offer is the issue offer: 122 and pipelined delivery (124).
    let offered = body["issue"]["stream"]["terminalDelivery"]["protocolVersions"]
        .as_array()
        .unwrap();
    assert!(
        offered.contains(&json!(122)) && offered.contains(&json!(124)),
        "{offered:?}"
    );
}

#[test]
fn an_attach_answer_must_name_this_session_and_pair_selection_with_issue() {
    let cases: Vec<(Box<dyn Fn(&Value) -> Value + Send + Sync>, &str)> = vec![
        (
            Box::new(|body| {
                let mut a = answer(body, Value::Null, Value::Null);
                a["liveSessionId"] = "live-session.ffffffffffffffffffff".into();
                a
            }),
            "changed",
        ),
        (
            Box::new(|body| {
                answer(
                    body,
                    json!({"semanticWindowId":null,"panes":["pane.a","pane.b"],"selectedPane":"pane.a"}),
                    Value::Null,
                )
            }),
            "format",
        ),
        (
            Box::new(|body| {
                answer(
                    body,
                    Value::Null,
                    issued(&body["issue"]["requestId"], &json!(["pane.a"])),
                )
            }),
            "format",
        ),
        (
            Box::new(|body| {
                answer(
                    body,
                    json!({"semanticWindowId":null,"panes":["pane.a","pane.b"],"selectedPane":"pane.a"}),
                    issued(&body["issue"]["requestId"], &json!(["pane.a"])),
                )
            }),
            "changed",
        ),
        (
            Box::new(|body| {
                answer(
                    body,
                    json!({"semanticWindowId":null,"panes":["pane.a","pane.b"],"selectedPane":"pane.a"}),
                    json!({"status":"error","error":{"code":"attachment-unavailable","reason":"r","retryable":true}}),
                )
            }),
            "no stream",
        ),
        (
            Box::new(|body| answer(body, Value::Null, Value::Null)),
            "no stream",
        ),
    ];
    for (shape, expected) in cases {
        let (route, _requests, _bodies) = attaching(shape);
        let client = Remote::new(route);
        let result = client.attach_session(LIVE, None, 24);
        match expected {
            "changed" => assert!(matches!(result, Err(Error::ServerChanged)), "{expected}"),
            "format" => assert!(matches!(result, Err(Error::ResourceFormat)), "{expected}"),
            _ => assert!(result.unwrap().stream.is_none(), "{expected}"),
        }
    }
}

#[test]
fn a_daemon_before_attach_gets_the_open_and_the_inventory_and_a_frame_redeem() {
    let (port, descriptor, requests) = daemon("2.9.26", Duration::from_secs(5), |line, body| {
        if line.contains("/pane-streams/issue") {
            let body: Value = serde_json::from_slice(body).unwrap();
            (200, issued(&body["requestId"], &json!(["pane.first"])))
        } else {
            route_answer(line)
        }
    });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    let client = Remote::new(route);
    drained(&requests);
    let attached = client.attach_session(LIVE, None, 24).unwrap();
    assert!(attached.stream.is_none());
    let lanes: Vec<_> = drained(&requests)
        .into_iter()
        .filter(|(_, l)| !l.starts_with("GET /identity "))
        .map(|(_, l)| l)
        .collect();
    assert_eq!(lanes.len(), 2, "{lanes:?}");
    assert!(lanes[0].contains("/open ") && lanes[1].contains("/inventory/"));
    let handoff = client
        .issue_terminal(&TerminalSelection {
            workspace_name: attached.workspace_name,
            live_session_id: LIVE.into(),
            selected_pane: "pane.first".into(),
            visible_panes: vec!["pane.first".into()],
            mode: crate::tmux_stream::ViewerMode::Interactive,
            window: None,
        })
        .unwrap();
    assert!(!handoff.upgrade.redeem_in_upgrade);
    // The socket proven for the stream during the open is the one it gets.
    assert!(handoff.upgrade.prepared.is_some());
}

/// A daemon that reports the attach version without the route (404) is
/// opened as before, and the stream's prepared socket is kept for the issue.
#[test]
fn an_attach_answered_404_falls_back_to_the_open_and_the_inventory() {
    let (port, descriptor, requests) = daemon("2.9.27", Duration::from_secs(5), |line, body| {
        if line.contains("/attach ") {
            (404, json!({"error":"not found"}))
        } else if line.contains("/pane-streams/issue") {
            let body: Value = serde_json::from_slice(body).unwrap();
            (200, issued(&body["requestId"], &json!(["pane.first"])))
        } else {
            route_answer(line)
        }
    });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    let client = Remote::new(route);
    let mut all = drained(&requests);
    let attached = client.attach_session(LIVE, None, 24).unwrap();
    assert_eq!(attached.workspace_name, "fixture");
    assert!(attached.stream.is_none());
    let seen = drained(&requests);
    all.extend(seen.iter().cloned());
    let lanes: Vec<_> = seen
        .into_iter()
        .filter(|(_, l)| !l.starts_with("GET /identity "))
        .map(|(_, l)| l)
        .collect();
    assert_eq!(lanes.len(), 3, "{lanes:?}");
    assert!(
        lanes[0].contains("/attach ")
            && lanes[1].contains("/open ")
            && lanes[2].contains("/inventory/")
    );
    let handoff = client
        .issue_terminal(&TerminalSelection {
            workspace_name: attached.workspace_name,
            live_session_id: LIVE.into(),
            selected_pane: "pane.first".into(),
            visible_panes: vec!["pane.first".into()],
            mode: crate::tmux_stream::ViewerMode::Interactive,
            window: None,
        })
        .unwrap();
    assert!(handoff.upgrade.prepared.is_some());
    // The socket proven during the attach is the one the issue hands on:
    // exactly one connection did nothing but prove the daemon's identity.
    all.extend(drained(&requests));
    let mut lines: HashMap<usize, Vec<String>> = HashMap::new();
    for (connection, line) in all {
        lines.entry(connection).or_default().push(line);
    }
    let proof_only = lines
        .values()
        .filter(|lines| lines.len() == 1 && lines[0].starts_with("GET /identity "))
        .count();
    assert_eq!(proof_only, 1, "{lines:?}");
}

/// review-460 (M1): a request that reached the daemon and then failed (here
/// the answer comes after the client's 2.5 s bound) is never sent again.
#[test]
fn a_received_request_that_then_fails_is_not_sent_again() {
    let (port, descriptor, requests) = daemon("2.9.26", Duration::from_secs(10), |line, _| {
        if line.contains("/open ") {
            thread::sleep(Duration::from_millis(3_500));
        }
        route_answer(line)
    });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    let client = Remote::new(route);
    drained(&requests);
    assert!(client.open_session(LIVE).is_err());
    thread::sleep(Duration::from_millis(4_000));
    let opens = drained(&requests)
        .into_iter()
        .filter(|(_, l)| l.contains("/open "))
        .count();
    assert_eq!(opens, 1);
}

/// review-460 (M6): a refused inventory read whose session is still listed
/// under another workspace alias reports the change.
#[test]
fn a_refused_inventory_read_reports_a_changed_alias() {
    let (port, descriptor, _requests) = daemon("2.9.12", Duration::from_secs(5), |line, _| {
        if line.contains("/inventory/") {
            (404, json!({"error":{"code":"workspace-not-found"}}))
        } else if line.contains("/sessions?") {
            let mut listed = sessions(true);
            listed["sessions"][0]["workspaceName"] = "renamed".into();
            (200, listed)
        } else {
            route_answer(line)
        }
    });
    let route = Arc::new(crate::tmux_ssh::RemoteTransport::fixture(port, descriptor).unwrap());
    let client = Remote::new(route);
    assert!(matches!(
        client.workspace_inventory(LIVE, "fixture"),
        Err(Error::ServerChanged)
    ));
}
