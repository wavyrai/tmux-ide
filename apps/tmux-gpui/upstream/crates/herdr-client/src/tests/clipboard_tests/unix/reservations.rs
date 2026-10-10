use super::*;

#[test]
fn reservation_validation_busy_drop_and_queue_bounds() {
    let (commands, rx) = queue::channel(1).unwrap();
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
    let target = ClientClipboardImageTarget::Pane("p".into());
    assert!(matches!(
        handle.reserve_clipboard_image("", target.clone()),
        Err(Error::MissingBootId)
    ));
    for id in [
        String::new(),
        "x".repeat(MAX_CLIPBOARD_IMAGE_TARGET_BYTES + 1),
    ] {
        assert!(matches!(
            handle.reserve_clipboard_image("boot", ClientClipboardImageTarget::Pane(id)),
            Err(Error::Protocol(protocol::Error::ClipboardImageTarget))
        ));
    }
    let upload = handle
        .reserve_clipboard_image("boot", target.clone())
        .unwrap();
    assert!(matches!(
        handle.reserve_clipboard_image("boot", target.clone()),
        Err(Error::ClipboardImageBusy)
    ));
    drop(upload);
    // A dropped slot still occupies the one lease until the worker skips it.
    assert!(matches!(
        handle.reserve_clipboard_image("boot", target.clone()),
        Err(Error::ClipboardImageBusy)
    ));
    drop(rx.try_recv().unwrap());
    handle.set_focus("boot", true).unwrap();
    assert!(matches!(
        handle.reserve_clipboard_image("boot", target.clone()),
        Err(Error::Full)
    ));
    drop(rx.try_recv().unwrap());
    let upload = handle
        .reserve_clipboard_image("boot", target.clone())
        .unwrap();
    let cancel = upload.cancellation_handle();
    cancel.cancel();
    assert!(upload.is_cancelled());
    assert!(matches!(
        upload.complete("png", vec![1]),
        Err(Error::ClipboardImageCancelled)
    ));
    drop(rx.try_recv().unwrap());
    // Retaining the cancellation handle cannot keep the lease busy.
    let upload = handle
        .reserve_clipboard_image("boot", target.clone())
        .unwrap();
    handle.disconnect();
    assert!(upload.is_cancelled());
    assert!(matches!(
        upload.complete("png", vec![1]),
        Err(Error::Disconnected)
    ));
    assert!(matches!(
        handle.reserve_clipboard_image("boot", target),
        Err(Error::Disconnected)
    ));
}

#[test]
fn input_reservations_share_queue_bound_without_claiming_or_releasing_image_lease() {
    use std::sync::atomic::Ordering;
    let (commands, rx) = queue::channel(COMMAND_CAPACITY).unwrap();
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
    let target = ClientClipboardImageTarget::Pane("p".into());
    for _ in 0..COMMAND_CAPACITY {
        drop(
            handle
                .reserve_clipboard_input("boot", target.clone())
                .unwrap(),
        );
    }
    assert!(!handle.inner.image_busy.load(Ordering::Acquire));
    assert!(matches!(
        handle.reserve_clipboard_input("boot", target.clone()),
        Err(Error::Full)
    ));
    assert!(matches!(
        handle.reserve_clipboard_image("boot", target.clone()),
        Err(Error::Full)
    ));
    assert!(!handle.inner.image_busy.load(Ordering::Acquire));
    assert!(matches!(handle.set_focus("boot", true), Err(Error::Full)));
    for _ in 0..COMMAND_CAPACITY {
        drop(rx.try_recv().unwrap());
    }

    let image = handle
        .reserve_clipboard_image("boot", target.clone())
        .unwrap();
    let image_slot = rx.try_recv().unwrap();
    let text = handle
        .reserve_clipboard_input("boot", target.clone())
        .unwrap();
    text.complete_input(ClientPaneInputEvent::Paste("text".into()))
        .unwrap();
    drop(rx.try_recv().unwrap());
    assert!(handle.inner.image_busy.load(Ordering::Acquire));
    let competing = handle
        .reserve_clipboard_input("boot", target.clone())
        .unwrap();
    // Busy takes precedence even over invalid data: no image encoding occurs.
    assert!(matches!(
        competing.complete("invalid", vec![]),
        Err(Error::ClipboardImageBusy)
    ));
    drop(rx.try_recv().unwrap());
    assert!(handle.inner.image_busy.load(Ordering::Acquire));
    drop(image);
    drop(image_slot);
    assert!(!handle.inner.image_busy.load(Ordering::Acquire));

    let deferred = handle
        .reserve_clipboard_input("boot", target.clone())
        .unwrap();
    assert!(!handle.inner.image_busy.load(Ordering::Acquire));
    deferred.complete("png", vec![1]).unwrap();
    assert!(handle.inner.image_busy.load(Ordering::Acquire));
    let deferred_slot = rx.try_recv().unwrap();
    let competing = handle
        .reserve_clipboard_input("boot", target.clone())
        .unwrap();
    assert!(matches!(
        competing.complete("png", vec![2]),
        Err(Error::ClipboardImageBusy)
    ));
    drop(rx.try_recv().unwrap());
    assert!(handle.inner.image_busy.load(Ordering::Acquire));
    drop(deferred_slot);
    assert!(!handle.inner.image_busy.load(Ordering::Acquire));
    let invalid = handle.reserve_clipboard_input("boot", target).unwrap();
    assert!(matches!(
        invalid.complete("png", vec![]),
        Err(Error::Protocol(protocol::Error::ClipboardImageSize))
    ));
    drop(rx.try_recv().unwrap());
    assert!(!handle.inner.image_busy.load(Ordering::Acquire));
}

#[test]
fn text_reserved_during_image_stays_before_later_input_and_competing_image_is_busy() {
    let (client, mut server, worker) = ready();
    let first = reserve(&client);
    let first_done = first.cancellation_handle();
    let target = ClientClipboardImageTarget::Pane("w1:p1".into());
    let text = client
        .handle
        .reserve_clipboard_input("boot-v1", target.clone())
        .unwrap();
    let text_done = text.cancellation_handle();
    let competing = client
        .handle
        .reserve_clipboard_input("boot-v1", target)
        .unwrap();
    let competing_done = competing.cancellation_handle();
    client
        .handle
        .send_input(
            "boot-v1",
            "w1:p1",
            [ClientPaneInputEvent::TextCommit("later".into())],
        )
        .unwrap();
    text.complete_input(ClientPaneInputEvent::Paste("original text".into()))
        .unwrap();
    assert!(matches!(
        competing.complete("png", vec![2]),
        Err(Error::ClipboardImageBusy)
    ));
    no_command(&mut server);
    assert!(!first_done.is_finished());
    assert!(!text_done.is_finished());
    first.complete("png", vec![1]).unwrap();
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClipboardImage {
            target: ClientClipboardImageTarget::Pane("w1:p1".into()),
            extension: "png".into(),
            data: vec![1],
        }
    );
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::Paste("original text".into())],
        }
    );
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::TextCommit("later".into())],
        }
    );
    assert!(first_done.is_finished() && text_done.is_finished() && competing_done.is_finished());
    drop(reserve(&client));
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn finished_tracks_slot_drop_not_publication_or_cancellation() {
    for mode in 0..4 {
        let (commands, rx) = queue::channel(1).unwrap();
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
        let upload = handle
            .reserve_clipboard_image("boot", ClientClipboardImageTarget::Pane("p".into()))
            .unwrap();
        let cancel = upload.cancellation_handle();
        let observer = cancel.clone();
        assert!(!cancel.is_finished());
        match mode {
            0 => upload.complete("png", vec![1]).unwrap(),
            1 => upload
                .complete_input(ClientPaneInputEvent::Paste("missing.png".into()))
                .unwrap(),
            2 => {
                cancel.cancel();
                drop(upload);
            }
            _ => {
                drop(upload);
            }
        }
        assert!(!observer.is_finished());
        let command = rx.try_recv().unwrap();
        assert!(!observer.is_finished());
        drop(command);
        assert!(cancel.is_finished());
        assert!(observer.is_finished());
    }
}

#[test]
fn pending_image_keeps_reads_alive_and_drop_skips_fifo_slot() {
    let (client, mut server, worker) = ready();
    client.handle.set_focus("boot-v1", true).unwrap();
    let upload = reserve(&client);
    client.handle.set_focus("boot-v1", false).unwrap();
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: true }
    );
    send(&mut server, ServerMessage::TerminalBell { count: 7 });
    assert!(matches!(
        event(&client),
        ClientEvent::Message(ServerMessage::TerminalBell { count: 7 })
    ));
    no_command(&mut server);
    drop(upload);
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: false }
    );
    drop(reserve(&client));
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn invalid_completion_skips_slot_and_preserves_protocol_source() {
    let (client, mut server, worker) = ready();
    let upload = reserve(&client);
    client.handle.set_focus("boot-v1", false).unwrap();
    let error = upload.complete("svg", vec![1]).unwrap_err();
    assert!(matches!(
        error,
        Error::Protocol(protocol::Error::ClipboardImageExtension)
    ));
    assert!(
        std::error::Error::source(&error)
            .unwrap()
            .is::<protocol::Error>()
    );
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: false }
    );
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn stale_boot_rejects_pending_reservation_without_blocking_fifo() {
    let (client, mut server, worker) = ready();
    let upload = client
        .handle
        .reserve_clipboard_image("stale", ClientClipboardImageTarget::DirectTerminal)
        .unwrap();
    let cancel = upload.cancellation_handle();
    client.handle.set_focus("boot-v1", false).unwrap();
    assert!(matches!(
        event(&client),
        ClientEvent::CommandRejected {
            reason: Error::CommandBoot,
            ..
        }
    ));
    assert_eq!(
        receive(&mut server),
        ClientMessage::ClientShellFocus { focused: false }
    );
    assert!(upload.is_cancelled());
    assert!(cancel.is_finished());
    assert!(matches!(
        upload.complete("png", vec![1]),
        Err(Error::ClipboardImageCancelled)
    ));
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}
