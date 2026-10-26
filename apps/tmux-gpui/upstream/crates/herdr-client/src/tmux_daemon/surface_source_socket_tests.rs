use super::*;
use crate::tmux_stream::ViewerMode;
use std::sync::Arc;

#[test]
fn surface_source_requests_only_read_only_binary_cells() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let peer = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        for index in 0..3 {
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline);
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
                assert!(head.len() < 16384);
            }
            let head = String::from_utf8(head).unwrap();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            assert!(length < 16384);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).unwrap();
            let reply = match index {
                0 => identity(),
                1 => registrations(),
                _ => {
                    assert!(head.starts_with("POST /api/v1/tmux-servers/"));
                    assert!(head.contains("Bearer must-never-be-sent-to-identity"));
                    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(body["stream"]["viewerMode"], "read-only");
                    assert_eq!(body["stream"]["panes"], serde_json::json!(["pane.first"]));
                    assert_eq!(
                        body["stream"]["terminalDelivery"]["protocolVersions"],
                        serde_json::json!([1, 109])
                    );
                    serde_json::json!({"status":"issued","descriptor":{
                        "protocolVersion":2,"webSocketUrl":format!("ws://127.0.0.1:{port}/v2/terminal/pane-streams/redeem"),
                        "subprotocol":"tmux-ide-pane-stream.v2","redemptionTicket":format!("ps2_{}","x".repeat(43)),
                        "daemonInstanceId":server_scope().generation,"requestId":body["requestId"],
                        "expiresAt":9999999999999u64,"panes":["pane.first"],"effectiveViewerMode":"read-only"}})
                }
            };
            socket.write_all(response(&reply).as_bytes()).unwrap();
        }
    });
    let sandbox = Sandbox::new();
    let daemon = Arc::new(LocalDaemon::discover(&sandbox.record(&value(port))).unwrap());
    let client = daemon.select_server(&server_scope()).unwrap();
    let mut selection = TerminalSelection {
        workspace_name: "fixture".into(),
        live_session_id: format!("live-session.{}", "a".repeat(20)),
        selected_pane: "pane.first".into(),
        visible_panes: vec!["pane.first".into()],
        mode: ViewerMode::Interactive,
    };
    assert!(matches!(
        client.issue_surface_source(&selection),
        Err(Error::TerminalSelection)
    ));
    selection.mode = ViewerMode::ReadOnly;
    selection.visible_panes.push("pane.second".into());
    assert!(matches!(
        client.issue_surface_source(&selection),
        Err(Error::TerminalSelection)
    ));
    selection.visible_panes.pop();
    let handoff = client.issue_surface_source(&selection).unwrap();
    assert!(!handoff.graphics && !handoff.native_surfaces && !handoff.alternate_screen_projection);
    assert!(handoff.binary_cells && handoff.local_images.is_none());
    assert_eq!(
        handoff.descriptor.effective_viewer_mode,
        ViewerMode::ReadOnly
    );
    peer.join().unwrap();
}
