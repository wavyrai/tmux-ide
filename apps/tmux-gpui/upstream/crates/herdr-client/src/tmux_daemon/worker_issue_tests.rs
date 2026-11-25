//! #872: a person's retry reaches the issue request the worker sends, and
//! only for a daemon that knows the field.
#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::OpenOptionsExt,
    thread,
    time::{Duration, Instant},
};

const INSTANCE: &str = "d9c81ebd-5785-45a3-9206-a2aa497d68fc";
const SERVER: &str = "tmux-server.0123456789abcdef0123456789abcdef";

fn reply(socket: &mut std::net::TcpStream, status: &str, body: &serde_json::Value) {
    let body = body.to_string();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(head.as_bytes()).unwrap();
    socket.write_all(body.as_bytes()).unwrap();
}
fn read(socket: &mut std::net::TcpStream) -> (String, Vec<u8>) {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        socket.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
        assert!(bytes.len() < 16384);
    }
    let head = String::from_utf8(bytes).unwrap();
    let length = head
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
    let mut body = vec![0; length];
    socket.read_exact(&mut body).unwrap();
    (head.lines().next().unwrap_or_default().to_owned(), body)
}
/// The issue request's body the worker sends to a local daemon of
/// `version` for `CatalogAction::Issue`, asked by a person or not.
fn issued(version: &str, asked: bool) -> serde_json::Value {
    let sandbox = super::super::tests::Sandbox::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let record = serde_json::json!({"pid":123,"port":port,"protocolVersion":4,"productVersion":version,"instanceId":INSTANCE,"startedAt":"2026-10-25T02:00:00Z","bindHostname":"127.0.0.1","authToken":"fixture-secret"});
    let mut identity = record.clone();
    identity.as_object_mut().unwrap().remove("authToken");
    identity["ok"] = true.into();
    let done = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&done);
    let peer = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
            let mut socket = match listener.accept() {
                Ok((socket, _)) => socket,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(e) => panic!("{e}"),
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let (line, body) = read(&mut socket);
            if line.contains("/pane-streams/issue") {
                reply(&mut socket, "200 OK", &serde_json::json!({}));
                return Some(serde_json::from_slice::<serde_json::Value>(&body).unwrap());
            } else if line.contains("/identity") {
                reply(&mut socket, "200 OK", &identity);
            } else if line.starts_with("GET ") && line.contains("tmux-servers") {
                reply(
                    &mut socket,
                    "200 OK",
                    &serde_json::json!({"version":1,"servers":[{"state":"online","label":"fixture","serverId":SERVER,"generation":INSTANCE}]}),
                );
            } else {
                reply(&mut socket, "404 Not Found", &serde_json::json!({}));
            }
        }
        None
    });
    let path = sandbox.0.join("daemon.json");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap()
        .write_all(record.to_string().as_bytes())
        .unwrap();
    let (record, fingerprint) = super::super::record::read(&path).unwrap();
    let owner = super::super::owner::Owner::Local(Arc::new(super::super::LocalDaemon {
        base_url: record.endpoint().unwrap(),
        record,
        fingerprint,
        path,
        agent: super::super::agent(),
    }));
    let scope = ServerScope {
        server_id: SERVER.into(),
        generation: INSTANCE.into(),
    };
    let _ = execute(
        &owner,
        &mut None,
        CatalogAction::Issue {
            scope,
            selection: TerminalSelection {
                workspace_name: "fixture".into(),
                live_session_id: "live-session.0123456789abcdef0123".into(),
                selected_pane: "pane.first".into(),
                visible_panes: vec!["pane.first".into()],
                mode: crate::tmux_stream::ViewerMode::Interactive,
                window: None,
            },
            retry_asked_by_person: asked,
        },
        &Arc::new(AtomicBool::new(false)),
    );
    done.store(true, Ordering::SeqCst);
    peer.join().unwrap().expect("no issue request was sent")
}
#[test]
fn a_person_s_retry_reaches_the_issue_request_of_a_daemon_that_knows_it() {
    assert_eq!(issued("2.9.28", true)["stream"]["retryAskedByPerson"], true);
    for (version, asked) in [("2.9.28", false), ("2.9.27", true), ("2.9.27", false)] {
        let sent = issued(version, asked);
        assert!(
            sent["stream"].get("retryAskedByPerson").is_none(),
            "{version} {asked}"
        );
        assert_eq!(sent["stream"]["panes"], serde_json::json!(["pane.first"]));
    }
}
