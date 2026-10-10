#![allow(clippy::unwrap_used, clippy::expect_used)]

use herdr_protocol::{endpoint::*, *};
use serde::Serialize;
use std::io::{self, Read};

#[test]
fn errors_preserve_codec_and_io_sources_and_validation_categories() {
    use std::error::Error as _;

    let error = decode_payload::<bool>(&[2]).unwrap_err();
    assert!(matches!(error, Error::Decode(_)));
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(matches!(
        error
            .source()
            .unwrap()
            .downcast_ref::<bincode::error::DecodeError>(),
        Some(bincode::error::DecodeError::InvalidBooleanValue(2))
    ));

    let error = encode_message(&"oversized", 1).unwrap_err();
    let source = error
        .source()
        .unwrap()
        .downcast_ref::<bincode::error::EncodeError>()
        .unwrap();
    let bincode::error::EncodeError::Io { inner, .. } = source else {
        panic!("expected bounded writer source")
    };
    assert!(matches!(
        inner.get_ref().unwrap().downcast_ref::<Error>(),
        Some(Error::FrameLimit)
    ));

    struct FailingIo;
    impl Read for FailingIo {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::from_raw_os_error(13))
        }
    }
    impl io::Write for FailingIo {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let error = read_message::<_, bool>(&mut FailingIo, 32).unwrap_err();
    assert_eq!(error.kind(), io::Error::from_raw_os_error(13).kind());
    assert_eq!(
        error
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .unwrap()
            .raw_os_error(),
        Some(13)
    );
    let error = write_message(&mut FailingIo, &true, 32).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::BrokenPipe);
    assert!(error.source().unwrap().is::<io::Error>());

    assert!(matches!(
        decode_payload::<bool>(&[0, 0]),
        Err(Error::TrailingBytes)
    ));
    assert!(matches!(
        read_message::<_, bool>(&mut &[0; 4][..], 32),
        Err(Error::FrameLimit)
    ));
    let mut invalid = surface();
    invalid.frame.cells.clear();
    assert!(matches!(invalid.frame.validate(), Err(Error::CellCount)));
}

fn payload(value: &impl Serialize) -> Vec<u8> {
    encode_message(value, MAX_GRAPHICS_FRAME_SIZE).unwrap()[4..].to_vec()
}
fn snapshot() -> ClientShellSnapshot {
    serde_json::from_str(include_str!("fixtures/endpoint-snapshot-v1.json")).unwrap()
}
fn surface() -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 7,
        surface_revision: 1,
        frame: FrameData {
            cells: vec![CellData {
                symbol: "x".into(),
                fg: 0x02123456,
                bg: 0x010000ff,
                modifier: 5,
                skip: false,
                hyperlink: Some(0),
            }],
            width: 1,
            height: 1,
            cursor: Some(CursorState {
                x: 0,
                y: 0,
                visible: true,
                shape: 6,
            }),
            hyperlinks: vec!["https://herdr.dev".into()],
            graphics: vec![],
        },
        panes: vec![],
        splits: vec![],
        popup: None,
        graphics: SurfaceGraphicsScene::default(),
    }
}

#[test]
fn upstream_json_fixtures_and_future_values() {
    let hello: EndpointClientHello =
        serde_json::from_str(include_str!("fixtures/endpoint-hello-v1.json")).unwrap();
    assert_eq!(hello.generation, 1);
    assert!(hello.surface_active);
    assert!(!hello.surface_reuse && !hello.surface_delta);
    let welcome: EndpointServerWelcome =
        serde_json::from_str(include_str!("fixtures/endpoint-welcome-v1.json")).unwrap();
    assert_eq!(welcome.input_codec, INPUT_CODEC_V1);
    assert!(welcome.capabilities.is_empty());
    let s = snapshot();
    assert_eq!(s.workspaces[0].agent_status, AgentStatus::Unknown);
    assert_eq!(s.tabs[0].agent_status, AgentStatus::Working);
    let mut value = serde_json::to_value(&s).unwrap();
    value["future"] = serde_json::json!({"anything": true});
    value["commands"][0]["action"] = "FutureAction".into();
    let future: ClientShellSnapshot = serde_json::from_value(value).unwrap();
    assert_eq!(future.commands[0].action, ClientShellCommandAction::Unknown);
    let binary = ServerMessage::ClientShellSnapshot(Box::new(s));
    assert_eq!(
        decode_payload::<ServerMessage>(&payload(&binary)).unwrap(),
        binary
    );
}

#[test]
fn all_client_tags_match_frozen_source_order() {
    let size = ClientSurfaceSize { cols: 80, rows: 24 };
    let messages = vec![
        ClientMessage::TerminalHello {
            version: 22,
            cols: 80,
            rows: 24,
            cell_width_px: 8,
            cell_height_px: 16,
            pixel_mouse: false,
        },
        ClientMessage::Input { data: vec![] },
        ClientMessage::ClipboardImage {
            target: ClientClipboardImageTarget::DirectTerminal,
            extension: "png".into(),
            data: vec![],
        },
        ClientMessage::Resize {
            cols: 80,
            rows: 24,
            cell_width_px: 8,
            cell_height_px: 16,
            pixel_mouse: false,
        },
        ClientMessage::Detach,
        ClientMessage::AttachTerminal {
            terminal_id: "t".into(),
            takeover: false,
        },
        ClientMessage::AttachScroll {
            source: AttachScrollSource::Wheel,
            direction: AttachScrollDirection::Up,
            lines: 1,
            column: None,
            row: None,
            modifiers: 0,
        },
        ClientMessage::ObserveTerminal { target: "p".into() },
        ClientMessage::ControlTerminal {
            target: "p".into(),
            takeover: false,
        },
        ClientMessage::GraphicsTransmissionResult {
            transfer_id: 1,
            image_id: 2,
            success: true,
        },
        ClientMessage::GraphicsTransmissionStarted {
            transfer_id: 1,
            image_id: 2,
        },
        ClientMessage::ClientShellHello {
            version: 22,
            cell_width_px: 8,
            cell_height_px: 16,
            surface_size: size,
            pixel_mouse: false,
            direct_graphics: false,
            endpoint_keybindings: false,
            mouse_capture: false,
        },
        ClientMessage::ClientShellResize {
            cell_width_px: 8,
            cell_height_px: 16,
            surface_size: size,
            pixel_mouse: false,
        },
        ClientMessage::ClientShellPaneInput {
            pane_id: "p".into(),
            events: vec![],
        },
        ClientMessage::ClientShellPopupInput {
            terminal_id: "t".into(),
            events: vec![],
        },
        ClientMessage::ClientShellEndpointRequest {
            boot_id: "b".into(),
            request: "{}".into(),
        },
        ClientMessage::AttachMouse {
            kind: ClientMouseKind::ScrollDown,
            position: ClientMousePosition::Cell { column: 1, row: 2 },
            geometry: None,
            modifiers: 0,
            lines: 3,
        },
        ClientMessage::ClientShellHostTheme {
            update: ClientHostThemeUpdate::Appearance(ClientHostAppearance::Dark),
        },
        ClientMessage::ClientShellFocus { focused: true },
        ClientMessage::ClientShellMouseCapture { enabled: true },
        ClientMessage::EndpointControl {
            kind: "".into(),
            data: "".into(),
        },
    ];
    for (tag, message) in messages.iter().enumerate() {
        let bytes = payload(message);
        assert_eq!(bytes[0], tag as u8);
        assert_eq!(decode_payload::<ClientMessage>(&bytes).unwrap(), *message);
    }
    assert_eq!(payload(messages.last().unwrap()), [20, 0, 0]);
}

#[test]
fn all_server_tags_match_frozen_source_order() {
    let messages = vec![
        ServerMessage::Welcome {
            version: 22,
            encoding: RenderEncoding::SemanticFrame,
            error: None,
        },
        ServerMessage::Terminal(TerminalFrame {
            seq: 1,
            width: 1,
            height: 1,
            full: true,
            bytes: vec![],
        }),
        ServerMessage::Graphics { bytes: vec![] },
        ServerMessage::ServerShutdown { reason: None },
        ServerMessage::Notify {
            kind: NotifyKind::Sound,
            message: "".into(),
            body: None,
        },
        ServerMessage::Clipboard { data: "".into() },
        ServerMessage::WindowTitle { title: None },
        ServerMessage::ReloadSoundConfig,
        ServerMessage::MouseCapture {
            enabled: false,
            sgr_pixels: false,
        },
        ServerMessage::TerminalBell { count: 1 },
        ServerMessage::GraphicsFile {
            path: "".into(),
            expected_len: 0,
            image_id: 0,
            transfer_id: 0,
            leading: vec![],
            control: "".into(),
            surface_asset: None,
        },
        ServerMessage::GraphicsTransmissionRetired {
            transfer_id: 0,
            image_id: 0,
        },
        ServerMessage::ClientShellSnapshot(Box::new(snapshot())),
        ServerMessage::PaneSurface(surface()),
        ServerMessage::SemanticNotification(SemanticNotification {
            kind: SemanticNotificationKind::Custom,
            title: "".into(),
            body: None,
            sound: None,
            agent: None,
            workspace_id: None,
            tab_id: None,
            pane_id: None,
            position: Some(ToastHerdrPosition::BottomRight),
        }),
        ServerMessage::ClientShellError { message: "".into() },
        ServerMessage::DirectTerminalKeyboardProtocol {
            flags: 0,
            modify_other_keys_level: 0,
        },
        ServerMessage::ClientShellKeyboardReportAll { enabled: false },
        ServerMessage::ClientShellEndpointResponseChunk {
            boot_id: "".into(),
            request_id: "".into(),
            final_chunk: true,
            data: vec![],
        },
        ServerMessage::PaneSurfacePatch(PaneSurfacePatch {
            boot_id: "".into(),
            projection_revision: 0,
            base_surface_revision: 0,
            surface_revision: 0,
            rows: vec![],
            panes: vec![],
            cursor: None,
        }),
        ServerMessage::EndpointControl {
            kind: "".into(),
            data: "".into(),
        },
    ];
    for (tag, message) in messages.iter().enumerate() {
        let bytes = payload(message);
        assert_eq!(bytes[0], tag as u8);
        assert_eq!(decode_payload::<ServerMessage>(&bytes).unwrap(), *message);
    }
    assert_eq!(payload(messages.last().unwrap()), [20, 0, 0]);
}

#[test]
fn semantic_key_matches_independent_source_shape() {
    // Independent positional source shape: outer tag 13, input tag 0,
    // key-code tag 15, kind tag 1, then ALL optional/Windows fields in order.
    let event = ClientPaneInputEvent::Key {
        code: ClientKeyCode::Char('a'),
        modifiers: 6,
        kind: ClientKeyKind::Repeat,
        repeat_count: 2,
        shifted_codepoint: Some(65),
        generated_text: Some("A".into()),
        tracks_release: true,
        physical_key_id: Some(30),
        windows_record: Some(WindowsKeyRecord {
            key_down: true,
            repeat_count: 2,
            virtual_key_code: 65,
            virtual_scan_code: 30,
            unicode: 65,
            control_key_state: 8,
        }),
    };
    let source_event = (
        0u32,
        (15u32, 'a'),
        6u8,
        1u32,
        2u16,
        Some(65u32),
        Some("A"),
        true,
        Some(30u32),
        Some((true, 2u16, 65u16, 30u16, 65u16, 8u32)),
    );
    let source = (13u32, "w1:p1", vec![source_event]);
    let actual = ClientMessage::ClientShellPaneInput {
        pane_id: "w1:p1".into(),
        events: vec![event],
    };
    assert_eq!(payload(&actual), payload(&source));
    assert_eq!(
        decode_payload::<ClientMessage>(&payload(&source)).unwrap(),
        actual
    );
    assert_eq!(
        payload(&ClientMessage::ClientShellResize {
            cell_width_px: 8,
            cell_height_px: 16,
            surface_size: ClientSurfaceSize { cols: 80, rows: 24 },
            pixel_mouse: false
        }),
        [12, 8, 16, 80, 24, 0]
    );
    assert_eq!(
        payload(&ClientMessage::ClientShellEndpointRequest {
            boot_id: "b".into(),
            request: "{}".into()
        }),
        [15, 1, b'b', 2, b'{', b'}']
    );
}

#[test]
fn surface_matches_independent_source_field_order() {
    let actual = ServerMessage::PaneSurface(surface());
    let source_cell = ("x", 0x02123456u32, 0x010000ffu32, 5u16, false, Some(0u32));
    let source_frame = (
        vec![source_cell],
        1u16,
        1u16,
        Some((0u16, 0u16, true, 6u8)),
        vec!["https://herdr.dev"],
        Vec::<u8>::new(),
    );
    let source = (
        13u32,
        "boot",
        7u64,
        1u64,
        source_frame,
        Vec::<u8>::new(),
        Vec::<u8>::new(),
        None::<u8>,
        (Vec::<u8>::new(), Vec::<u8>::new(), Vec::<u8>::new()),
    );
    assert_eq!(payload(&actual), payload(&source));
    assert_eq!(
        decode_payload::<ServerMessage>(&payload(&source)).unwrap(),
        actual
    );
}

#[test]
fn framing_limits_truncation_trailing_bytes_and_hostile_lengths() {
    assert!(encode_message(&(), MAX_FRAME_SIZE).is_err());
    assert!(decode_payload::<()>(&[]).is_err());
    assert!(read_message::<_, ()>(&mut &[0u8; 4][..], MAX_FRAME_SIZE).is_err());
    let message = ClientMessage::Detach;
    let bytes = encode_message(&message, 1).unwrap();
    assert_eq!(bytes, [1, 0, 0, 0, 4]);
    assert!(encode_message(&message, 0).is_err());
    assert!(decode_payload::<ClientMessage>(&[4, 0]).is_err());
    assert!(read_message::<_, ClientMessage>(&mut &bytes[..4], 1).is_err());
    assert!(
        read_message::<_, ClientMessage>(&mut &u32::MAX.to_le_bytes()[..], MAX_FRAME_SIZE).is_err()
    );
    assert!(read_message::<_, ClientMessage>(&mut &[0u8; 4][..], MAX_FRAME_SIZE).is_err());
    // Input Vec length claims u64::MAX but has no payload. Decoder must reject it.
    let mut hostile = vec![1, 253];
    hostile.extend(u64::MAX.to_le_bytes());
    assert!(decode_payload::<ClientMessage>(&hostile).is_err());
    struct OneByte<'a>(&'a [u8]);
    impl Read for OneByte<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let len = buf.len().min(1);
            self.0.read(&mut buf[..len])
        }
    }
    assert_eq!(
        read_message::<_, ClientMessage>(&mut OneByte(&bytes), 1).unwrap(),
        message
    );
}

#[test]
fn patch_validation_is_atomic() {
    let mut s = surface();
    let original = s.clone();
    let row = PaneSurfacePatchRow {
        x: 0,
        y: 0,
        cells: vec![CellData {
            symbol: "y".into(),
            ..s.frame.cells[0].clone()
        }],
    };
    let mut patch = PaneSurfacePatch {
        boot_id: "boot".into(),
        projection_revision: 7,
        base_surface_revision: 1,
        surface_revision: 2,
        rows: vec![row],
        panes: vec![],
        cursor: None,
    };
    patch.rows.push(PaneSurfacePatchRow {
        x: 1,
        y: 0,
        cells: patch.rows[0].cells.clone(),
    });
    assert!(s.apply_patch(patch.clone()).is_err());
    assert_eq!(s, original);
    patch.rows.pop();
    let mut stale = patch.clone();
    stale.boot_id = "old".into();
    assert!(s.apply_patch(stale).is_err());
    s.apply_patch(patch.clone()).unwrap();
    assert_eq!(s.frame.cells[0].symbol, "y");
    assert_eq!(s.surface_revision, 2);
    assert!(s.apply_patch(patch).is_err());
    s.frame.cells.clear();
    assert!(s.frame.validate().is_err());
}
