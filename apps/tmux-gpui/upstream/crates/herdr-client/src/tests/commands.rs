use super::*;

#[test]
fn requests_wait_for_final_response_and_preserve_fifo() {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    let first = client.handle.focus_pane("boot-v1", "w1:p1").unwrap();
    let second = client.handle.focus_pane("boot-v1", "w1:p2").unwrap();
    client.handle.set_focus("boot-v1", false).unwrap();
    assert!(
        matches!(receive(&mut server), ClientMessage::ClientShellEndpointRequest { request, .. }
        if serde_json::from_str::<Value>(&request).unwrap()["id"] == first)
    );
    send(
        &mut server,
        ServerMessage::ClientShellEndpointResponseChunk {
            boot_id: "boot-v1".into(),
            request_id: first.clone(),
            final_chunk: false,
            data: format!("{{\"id\":\"{first}\",").into_bytes(),
        },
    );
    server
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let mut byte = [0];
    assert!(matches!(
        server.read(&mut byte).unwrap_err().kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    ));
    send(
        &mut server,
        ServerMessage::ClientShellEndpointResponseChunk {
            boot_id: "boot-v1".into(),
            request_id: first,
            final_chunk: true,
            data: b"\"result\":{}}".to_vec(),
        },
    );
    assert!(matches!(event(&client), ClientEvent::Response { .. }));
    assert!(
        matches!(receive(&mut server), ClientMessage::ClientShellEndpointRequest { request, .. }
        if serde_json::from_str::<Value>(&request).unwrap()["id"] == second)
    );
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: false }
    );
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn bounded_command_queue_and_outbound_limit_are_explicit() {
    let (commands, _rx) = queue::channel(1).unwrap();
    let handle = ClientHandle {
        inner: Arc::new(HandleInner {
            commands,
            stop: Arc::new(AtomicBool::new(false)),
            next_request: AtomicU64::new(1),
            image_busy: Arc::new(AtomicBool::new(false)),
            last_queued_theme: Default::default(),
            liveness: Default::default(),
        }),
    };
    assert!(matches!(
        handle.set_focus("", true),
        Err(Error::MissingBootId)
    ));
    handle.set_focus("boot", true).unwrap();
    assert!(matches!(handle.set_focus("boot", false), Err(Error::Full)));
    assert!(matches!(
        handle.send_input(
            "boot",
            "p",
            vec![ClientPaneInputEvent::Paste("x".repeat(MAX_FRAME_SIZE))]
        ),
        Err(Error::Protocol(protocol::Error::Encode(_)))
    ));
    handle.disconnect();
    assert!(matches!(
        handle.set_focus("boot", false),
        Err(SendError::Disconnected)
    ));
}

#[test]
fn cancellation_interrupts_full_event_queue_and_idle_read() {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    for _ in 0..EVENT_CAPACITY + 2 {
        send(&mut server, ServerMessage::TerminalBell { count: 1 });
    }
    client.handle.disconnect();
    // Cancellation during a bounded send returns Interrupted; idle cancellation returns Ok.
    let result = worker.join().unwrap();
    assert!(result.is_ok() || result.unwrap_err().kind() == io::ErrorKind::Interrupted);

    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    drop(client.handle); // Last handle drop also cancels.
    worker.join().unwrap().unwrap();
}

// Binds the endpoint and then deletes it. A Windows named pipe has no such
// filesystem identity: removing the path leaves the pipe listening.
#[cfg(unix)]
#[test]
fn public_connect_delivers_shutdown_and_socket_failure() {
    use std::sync::atomic::Ordering;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    // Deep worktree paths can exceed the Unix socket address limit on macOS.
    let path = std::env::temp_dir().join(format!(
        "test-{}-{}.sock",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let listener = Listener::bind(&path).unwrap();
    let client = connect(
        ConnectTarget::Socket(path.clone()),
        ConnectOptions::default(),
    )
    .unwrap();
    let (mut server, _) = listener.accept().unwrap();
    std::fs::remove_file(&path).unwrap();
    handshake(&mut server);
    event(&client);
    event(&client);
    send(
        &mut server,
        ServerMessage::ServerShutdown {
            reason: Some("test shutdown".into()),
        },
    );
    assert!(
        matches!(event(&client), ClientEvent::Disconnected { reason, .. } if reason == "test shutdown")
    );
    let missing = connect(ConnectTarget::Socket(path), ConnectOptions::default()).unwrap();
    assert!(matches!(event(&missing), ClientEvent::Disconnected { .. }));
}

#[test]
fn cancellation_does_not_flush_commands_behind_pending_request() {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    let first = client.handle.focus_pane("boot-v1", "w1:p1").unwrap();
    client.handle.focus_pane("boot-v1", "w1:p2").unwrap();
    client.handle.set_focus("boot-v1", false).unwrap();
    assert!(
        matches!(receive(&mut server), ClientMessage::ClientShellEndpointRequest { request, .. }
        if serde_json::from_str::<Value>(&request).unwrap()["id"] == first)
    );
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
    assert_eq!(server.read(&mut [0]).unwrap(), 0);
    assert!(client.events.try_recv().is_err());
}

#[test]
fn stale_boot_and_unsupported_commands_never_reach_socket() {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    client
        .handle
        .send_input(
            "old-boot",
            "w1:p1",
            vec![ClientPaneInputEvent::Paste("bad".into())],
        )
        .unwrap();
    assert!(matches!(
        event(&client),
        ClientEvent::CommandRejected {
            request_id: None,
            reason: Error::CommandBoot,
        }
    ));
    for method in [
        Method::TabCreate,
        Method::WorktreeList,
        Method::WorktreeOpen,
    ] {
        let unsupported = client.handle.request("boot-v1", method, json!({})).unwrap();
        assert!(
            matches!(event(&client), ClientEvent::CommandRejected { request_id: Some(id), reason: Error::UnsupportedMethod } if id == unsupported)
        );
    }
    client.handle.set_focus("boot-v1", true).unwrap();
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: true }
    );
    let mut snapshot: Value = serde_json::from_str(SNAPSHOT).unwrap();
    snapshot["boot_id"] = "replacement-boot".into();
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: snapshot.to_string(),
        },
    );
    assert!(
        worker
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("boot changed")
    );
}
