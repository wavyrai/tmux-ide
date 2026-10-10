use super::*;

#[test]
fn fallback_paste_uses_reserved_target_and_precedes_later_enter() {
    for target in [
        ClientClipboardImageTarget::Pane("w1:p1".into()),
        ClientClipboardImageTarget::Popup("popup-1".into()),
    ] {
        let (client, mut server, worker) = ready();
        let upload = client
            .handle
            .reserve_clipboard_image("boot-v1", target.clone())
            .unwrap();
        let enter = ClientPaneInputEvent::Key {
            code: ClientKeyCode::Enter,
            modifiers: 0,
            kind: ClientKeyKind::Press,
            repeat_count: 1,
            shifted_codepoint: None,
            generated_text: None,
            tracks_release: false,
            physical_key_id: None,
            windows_record: None,
        };
        client
            .handle
            .send_input("boot-v1", "w1:p2", [enter.clone()])
            .unwrap();
        no_command(&mut server);
        // File eligibility is determined by the caller; the client preserves
        // the original text verbatim, including shell quoting and newlines.
        let text = "'/missing image.png'\n";
        upload
            .complete_input(ClientPaneInputEvent::Paste(text.into()))
            .unwrap();
        let events = vec![ClientPaneInputEvent::Paste(text.into())];
        let expected = match target {
            ClientClipboardImageTarget::Pane(pane_id) => {
                ClientMessage::ClientShellPaneInput { pane_id, events }
            }
            ClientClipboardImageTarget::Popup(terminal_id) => {
                ClientMessage::ClientShellPopupInput {
                    terminal_id,
                    events,
                }
            }
            ClientClipboardImageTarget::DirectTerminal => unreachable!(),
        };
        assert_eq!(receive(&mut server), expected);
        assert_eq!(
            receive(&mut server),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p2".into(),
                events: vec![enter]
            }
        );
        client.handle.disconnect();
        worker.join().unwrap().unwrap();
    }
}

#[test]
fn ctrl_v_fallback_preserves_original_key_before_later_input() {
    for target in [
        ClientClipboardImageTarget::Pane("w1:p1".into()),
        ClientClipboardImageTarget::Popup("popup-1".into()),
    ] {
        let (client, mut server, worker) = ready();
        let upload = client
            .handle
            .reserve_clipboard_image("boot-v1", target.clone())
            .unwrap();
        let cancellation = upload.cancellation_handle();
        let key = ClientPaneInputEvent::Key {
            code: ClientKeyCode::Char('v'),
            modifiers: 2,
            kind: ClientKeyKind::Press,
            repeat_count: 1,
            shifted_codepoint: Some(u32::from('V')),
            generated_text: Some("\u{16}".into()),
            tracks_release: true,
            physical_key_id: Some(9),
            windows_record: Some(WindowsKeyRecord {
                key_down: true,
                repeat_count: 1,
                virtual_key_code: 86,
                virtual_scan_code: 47,
                unicode: 22,
                control_key_state: 8,
            }),
        };
        client
            .handle
            .send_input(
                "boot-v1",
                "w1:p2",
                [ClientPaneInputEvent::TextCommit("later".into())],
            )
            .unwrap();
        no_command(&mut server);
        assert!(!cancellation.is_finished());
        // The background clipboard result is empty: preserve the exact
        // original key, including platform and physical-key metadata.
        upload.complete_input(key.clone()).unwrap();
        let events = vec![key];
        let expected = match target {
            ClientClipboardImageTarget::Pane(pane_id) => {
                ClientMessage::ClientShellPaneInput { pane_id, events }
            }
            ClientClipboardImageTarget::Popup(terminal_id) => {
                ClientMessage::ClientShellPopupInput {
                    terminal_id,
                    events,
                }
            }
            ClientClipboardImageTarget::DirectTerminal => unreachable!(),
        };
        assert_eq!(receive(&mut server), expected);
        assert_eq!(
            receive(&mut server),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p2".into(),
                events: vec![ClientPaneInputEvent::TextCommit("later".into())],
            }
        );
        assert!(cancellation.is_finished());
        client.handle.disconnect();
        worker.join().unwrap().unwrap();
    }
}

#[test]
fn fallback_respects_cancellation_direct_target_and_ordinary_limit() {
    for mode in 0..4 {
        let (client, mut server, worker) = ready();
        let target = if mode == 0 {
            ClientClipboardImageTarget::DirectTerminal
        } else {
            ClientClipboardImageTarget::Pane("w1:p1".into())
        };
        let upload = client
            .handle
            .reserve_clipboard_image("boot-v1", target)
            .unwrap();
        client.handle.set_focus("boot-v1", false).unwrap();
        if mode == 2 {
            upload.cancellation_handle().cancel();
        }
        if mode == 3 {
            client.handle.disconnect();
        }
        let text = if mode == 1 {
            "x".repeat(MAX_FRAME_SIZE)
        } else {
            "missing.png".into()
        };
        let error = upload
            .complete_input(ClientPaneInputEvent::Paste(text))
            .unwrap_err();
        match mode {
            0 => assert!(matches!(error, Error::ClipboardImageInputTarget)),
            1 => assert!(matches!(error, Error::Protocol(protocol::Error::Encode(_)))),
            2 => assert!(matches!(error, Error::ClipboardImageCancelled)),
            _ => assert!(matches!(error, Error::Disconnected)),
        }
        if mode != 3 {
            assert_eq!(
                receive(&mut server),
                ClientMessage::ClientShellFocus { focused: false }
            );
        }
        client.handle.disconnect();
        worker.join().unwrap().unwrap();
    }
}
