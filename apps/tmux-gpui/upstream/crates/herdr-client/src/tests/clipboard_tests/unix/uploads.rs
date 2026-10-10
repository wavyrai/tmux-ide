use super::*;

#[test]
fn sustained_inbound_progress_survives_a_backpressured_outgoing_image() {
    let (client, mut server, worker) = ready();
    let upload = reserve(&client);
    let cancel = upload.cancellation_handle();
    upload
        .complete("png", vec![99; MAX_CLIPBOARD_IMAGE_PAYLOAD])
        .unwrap();
    let mut prefix = [0; 4];
    server.read_exact(&mut prefix).unwrap();
    // Never drain the image. Repeated large inbound frames must still finish
    // within the unchanged partial-frame deadline while outbound writes stall.
    for value in [11, 22] {
        let started = Instant::now();
        send(
            &mut server,
            ServerMessage::Graphics {
                bytes: vec![value; 24 * 1024 * 1024],
            },
        );
        assert!(
            matches!(event(&client), ClientEvent::Message(ServerMessage::Graphics { bytes })
            if bytes.len() == 24 * 1024 * 1024 && bytes.iter().all(|byte| *byte == value))
        );
        assert!(started.elapsed() < TIMEOUT);
        assert!(
            !cancel.is_finished(),
            "publication is not worker completion"
        );
    }
    cancel.cancel();
    assert!(matches!(
        worker.join().unwrap(),
        Err(Error::ClipboardImageCancelled)
    ));
    assert!(cancel.is_finished());
}

#[test]
fn expired_preparation_skips_retained_permit_but_not_published_data() {
    use crate::clipboard::{ImageLease, ImageSlot};
    use crate::handle::Command;
    use std::sync::atomic::Ordering;

    for published in [false, true] {
        let (client, mut server, worker) = ready();
        // Inject an aged reservation rather than sleeping for its deadline.
        let lease = Arc::new(ImageLease {
            busy: client.handle.inner.image_busy.clone(),
            claimed: AtomicBool::new(true),
            cancelled: Arc::new(AtomicBool::new(false)),
            finished: Arc::new(AtomicBool::new(false)),
            reserved_at: Instant::now() - COMMAND_TIMEOUT,
        });
        assert!(!lease.busy.swap(true, Ordering::AcqRel));
        let (sender, receiver) = bounded(1);
        let upload = ClipboardImageUpload {
            target: ClientClipboardImageTarget::Pane("w1:p1".into()),
            sender,
            lease: lease.clone(),
            stop: client.handle.inner.stop.clone(),
        };
        let expected = ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::Paste("original.png".into())],
        };
        if published {
            upload
                .sender
                .try_send(encode_message(&expected, MAX_FRAME_SIZE).unwrap())
                .unwrap();
        }
        client
            .handle
            .inner
            .commands
            .try_send(Command {
                boot_id: "boot-v1".into(),
                bytes: Vec::new(),
                request: None,
                image: Some(ImageSlot {
                    receiver,
                    lease,
                    writer: Default::default(),
                }),
            })
            .unwrap_or_else(|_| panic!("empty queue"));
        client.handle.set_focus("boot-v1", false).unwrap();
        assert!(upload.is_cancelled());
        if published {
            assert_eq!(receive(&mut server), expected);
        } else {
            assert!(matches!(
                event(&client),
                ClientEvent::CommandRejected {
                    request_id: None,
                    reason: Error::ClipboardImagePreparationTimeout,
                }
            ));
        }
        // The retained permit cannot stall ordinary input after expiration.
        assert_eq!(
            receive(&mut server),
            ClientMessage::ClientShellFocus { focused: false }
        );
        assert!(matches!(
            client
                .handle
                .reserve_clipboard_image("boot-v1", ClientClipboardImageTarget::DirectTerminal),
            Err(Error::ClipboardImageBusy)
        ));
        assert!(matches!(
            upload.complete_input(ClientPaneInputEvent::Paste("late.png".into())),
            Err(Error::ClipboardImageCancelled)
        ));
        drop(reserve(&client));
        client.handle.disconnect();
        worker.join().unwrap().unwrap();
    }
}

#[test]
fn partial_inbound_frame_cannot_stall_an_already_started_upload() {
    let (client, mut server, worker) = ready();
    reserve(&client)
        .complete("png", vec![88; MAX_CLIPBOARD_IMAGE_PAYLOAD])
        .unwrap();
    client.handle.set_focus("boot-v1", false).unwrap();
    let mut prefix = [0; 4];
    server.read_exact(&mut prefix).unwrap();
    // The outbound image has started. Simulate a peer that must drain that
    // frame before it can finish producing its own inbound frame.
    let inbound =
        encode_message(&ServerMessage::TerminalBell { count: 12 }, MAX_FRAME_SIZE).unwrap();
    server.write_all(&inbound[..4]).unwrap();
    let mut payload = vec![0; u32::from_le_bytes(prefix) as usize];
    server.read_exact(&mut payload).unwrap();
    assert!(matches!(decode_payload::<ClientMessage>(&payload).unwrap(),
        ClientMessage::ClipboardImage { data, .. }
        if data.len() == MAX_CLIPBOARD_IMAGE_PAYLOAD && data.iter().all(|b| *b == 88)));
    // Only the continuation bypasses partial inbound state, not later input.
    no_command(&mut server);
    server.write_all(&inbound[4..]).unwrap();
    assert!(matches!(
        event(&client),
        ClientEvent::Message(ServerMessage::TerminalBell { count: 12 })
    ));
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: false }
    );
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn ready_image_waits_behind_request_lease_and_precedes_later_input() {
    let (client, mut server, worker) = ready();
    let first = client.handle.focus_pane("boot-v1", "w1:p1").unwrap();
    let second = client.handle.focus_pane("boot-v1", "w1:p2").unwrap();
    let upload = reserve(&client);
    client.handle.set_focus("boot-v1", false).unwrap();
    upload
        .complete("jpeg", vec![42; MAX_FRAME_SIZE + 1])
        .unwrap();
    assert!(matches!(
        receive(&mut server),
        ClientMessage::ClientShellEndpointRequest { .. }
    ));
    no_command(&mut server);
    send(
        &mut server,
        ServerMessage::ClientShellEndpointResponseChunk {
            boot_id: "boot-v1".into(),
            request_id: first.clone(),
            final_chunk: true,
            data: json!({"id": first, "result": {}}).to_string().into_bytes(),
        },
    );
    assert!(matches!(event(&client), ClientEvent::Response { .. }));
    assert!(
        matches!(receive(&mut server), ClientMessage::ClientShellEndpointRequest { request, .. }
        if serde_json::from_str::<Value>(&request).unwrap()["id"] == second)
    );
    // Images (like normal input) do not acquire or wait on the API lease.
    let message: ClientMessage = read_message(&mut server, MAX_CLIPBOARD_IMAGE_FRAME_SIZE).unwrap();
    assert_eq!(
        message,
        ClientMessage::ClipboardImage {
            target: ClientClipboardImageTarget::Pane("w1:p1".into()),
            extension: "jpg".into(),
            data: vec![42; MAX_FRAME_SIZE + 1],
        }
    );
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: false }
    );
    drop(reserve(&client));
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn preparing_upload_does_not_keep_last_client_handle_alive() {
    let (client, _server, worker) = ready();
    let upload = reserve(&client);
    drop(client.handle);
    worker.join().unwrap().unwrap();
    assert!(upload.is_cancelled());
}

#[test]
fn backpressured_image_reads_events_and_cancellation_or_boot_change_closes_frame() {
    for mode in 0..4 {
        let (client, mut server, worker) = ready();
        let upload = reserve(&client);
        let cancel = upload.cancellation_handle();
        upload
            .complete("png", vec![99; MAX_CLIPBOARD_IMAGE_PAYLOAD])
            .unwrap();
        client.handle.set_focus("boot-v1", false).unwrap();
        let mut prefix = [0; 4];
        server.read_exact(&mut prefix).unwrap();
        let len = u32::from_le_bytes(prefix) as usize;
        // Stop consuming a 16 MiB frame. The worker must still read messages.
        send(&mut server, ServerMessage::TerminalBell { count: 9 });
        assert!(matches!(
            event(&client),
            ClientEvent::Message(ServerMessage::TerminalBell { count: 9 })
        ));
        assert!(matches!(
            client
                .handle
                .reserve_clipboard_image("boot-v1", ClientClipboardImageTarget::DirectTerminal),
            Err(Error::ClipboardImageBusy)
        ));
        match mode {
            0 => cancel.cancel(),
            1 => client.handle.disconnect(),
            3 => {
                // Resume a slow reader: offsets must produce one exact frame,
                // with the next command following it rather than interleaving.
                let mut payload = vec![0; len];
                server.read_exact(&mut payload).unwrap();
                assert!(matches!(decode_payload::<ClientMessage>(&payload).unwrap(),
                    ClientMessage::ClipboardImage { data, .. }
                    if data.len() == MAX_CLIPBOARD_IMAGE_PAYLOAD && data.iter().all(|b| *b == 99)));
                assert_eq!(
                    receive(&mut server),
                    ClientMessage::ClientShellFocus { focused: false }
                );
                assert!(cancel.is_finished());
                client.handle.disconnect();
                worker.join().unwrap().unwrap();
                continue;
            }
            _ => send(
                &mut server,
                ServerMessage::EndpointControl {
                    kind: ENDPOINT_SNAPSHOT_KIND.into(),
                    data: SNAPSHOT.replace("boot-v1", "new-boot"),
                },
            ),
        }
        let result = worker.join().unwrap();
        match mode {
            0 => assert!(matches!(result, Err(Error::ClipboardImageCancelled))),
            1 => result.unwrap(),
            _ => assert!(matches!(result, Err(Error::SnapshotIdentity))),
        }
        let mut remainder = Vec::new();
        server.read_to_end(&mut remainder).unwrap();
        assert!(
            remainder.len() < len,
            "must close rather than complete/replay a cancelled frame"
        );
        assert!(cancel.cancelled.load(std::sync::atomic::Ordering::Acquire));
    }
}

#[test]
fn completing_image_cannot_bypass_a_partial_inbound_boot_change() {
    let (client, mut server, worker) = ready();
    let upload = reserve(&client);
    let message = encode_message(
        &ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: SNAPSHOT.replace("boot-v1", "new-boot"),
        },
        MAX_FRAME_SIZE,
    )
    .unwrap();
    server.write_all(&message[..5]).unwrap();
    // Hold the inbound frame incomplete across read polls. Completing the
    // upload must not let it bypass that frame's boot validation.
    no_command(&mut server);
    upload.complete("png", vec![1; MAX_FRAME_SIZE + 1]).unwrap();
    no_command(&mut server);
    server.write_all(&message[5..]).unwrap();
    assert!(matches!(
        worker.join().unwrap(),
        Err(Error::SnapshotIdentity)
    ));
    assert_eq!(server.read(&mut [0]).unwrap(), 0);
}

#[test]
fn pending_upload_allows_health_probe_and_response() {
    let (client, mut server, worker) = test_client_mode(true, true);
    receive(&mut server);
    let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
    welcome["capabilities"] = json!([
        "health_check",
        "surface_interest",
        "presentation_effects_fence"
    ]);
    welcome["methods"]
        .as_array_mut()
        .unwrap()
        .push(json!("client_shell.surface.set"));
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_WELCOME_KIND.into(),
            data: welcome.to_string(),
        },
    );
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: SNAPSHOT.into(),
        },
    );
    event(&client);
    event(&client);
    let upload = reserve(&client);
    client.handle.set_focus("boot-v1", false).unwrap();
    server
        .set_read_timeout(Some(Duration::from_secs(7)))
        .unwrap();
    assert!(
        matches!(receive(&mut server), ClientMessage::EndpointControl { kind, .. } if kind == "endpoint.health.ping.v1")
    );
    send(&mut server, ServerMessage::TerminalBell { count: 11 });
    assert!(matches!(
        event(&client),
        ClientEvent::Message(ServerMessage::TerminalBell { count: 11 })
    ));
    upload.cancellation_handle().cancel();
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: false }
    );
    assert!(upload.is_cancelled());
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}
