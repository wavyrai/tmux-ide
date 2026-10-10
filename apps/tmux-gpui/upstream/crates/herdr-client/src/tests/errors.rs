use super::*;

#[test]
fn errors_preserve_sources_and_retry_categories() {
    use std::error::Error as _;

    // The same refusal: EACCES on POSIX, ERROR_ACCESS_DENIED on Windows. The
    // point is that a real OS code keeps both its category and its raw value.
    const DENIED: i32 = if cfg!(windows) { 5 } else { 13 };
    struct Denied;
    impl Read for Denied {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::from_raw_os_error(DENIED))
        }
    }
    let error = FrameReader::new().poll(&mut Denied).unwrap_err();
    assert!(matches!(error, Error::Io(_)));
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(
        error
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .unwrap()
            .raw_os_error(),
        Some(DENIED)
    );

    let mut reader = FrameReader::new();
    let mut input = io::Cursor::new(vec![1, 0, 0, 0, 255]);
    assert!(reader.poll(&mut input).unwrap().is_none());
    let error = reader.poll(&mut input).unwrap_err();
    assert!(matches!(error, Error::Protocol(protocol::Error::Decode(_))));
    assert!(error.source().unwrap().is::<protocol::Error>());
    assert!(error.source().unwrap().source().is_some());

    let error = Session::new(true, false)
        .handle_message(
            ServerMessage::EndpointControl {
                kind: ENDPOINT_WELCOME_KIND.into(),
                data: "{".into(),
            },
            |_| Ok(()),
        )
        .unwrap_err();
    assert!(matches!(error, Error::Json(_)));
    assert!(error.source().unwrap().is::<serde_json::Error>());
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);

    for (error, kind) in [
        (Error::Cancelled, io::ErrorKind::Interrupted),
        (Error::SshCancelled, io::ErrorKind::Interrupted),
        (Error::EventReceiverDropped, io::ErrorKind::BrokenPipe),
        (Error::SocketClosed, io::ErrorKind::UnexpectedEof),
        (Error::SshClosed, io::ErrorKind::UnexpectedEof),
        (Error::HealthTimeout, io::ErrorKind::TimedOut),
        (Error::SshTimeout, io::ErrorKind::TimedOut),
        (Error::PartialFrameTimeout, io::ErrorKind::InvalidData),
        (Error::HandshakeTimeout, io::ErrorKind::InvalidData),
        (Error::RequestTimeout, io::ErrorKind::InvalidData),
        (Error::InvalidSession, io::ErrorKind::InvalidInput),
        (Error::SshUnsupported, io::ErrorKind::Unsupported),
    ] {
        assert_eq!(error.kind(), kind, "{error}");
    }
}

#[test]
fn disconnect_presentation_is_sanitized_and_bounded() {
    let client = connect_with_connector(
        ConnectTarget::Local,
        ConnectOptions::default(),
        true,
        |_, _| Err::<Stream, _>(io::Error::other("\u{1b}\n\r\t\0x".repeat(2048))),
    )
    .unwrap();
    let ClientEvent::Disconnected { reason, .. } = event(&client) else {
        panic!("expected disconnect")
    };
    assert_eq!(reason.chars().count(), 1024);
    assert!(!reason.chars().any(char::is_control));
}

#[test]
fn connect_options_equality_and_send_error_display() {
    let options = ConnectOptions::default();
    assert_eq!(options, ConnectOptions::default());
    for changed in [
        ConnectOptions {
            surface_size: ClientSurfaceSize { cols: 81, rows: 24 },
            ..options
        },
        ConnectOptions {
            surface_size: ClientSurfaceSize { cols: 80, rows: 25 },
            ..options
        },
        ConnectOptions {
            cell_width_px: 8,
            ..options
        },
        ConnectOptions {
            cell_height_px: 16,
            ..options
        },
    ] {
        assert_ne!(options, changed);
    }
    assert_eq!(SendError::Full.to_string(), "client command queue is full");
    assert_eq!(
        SendError::Disconnected.to_string(),
        "client is disconnected"
    );
    assert_eq!(
        Error::MissingBootId.to_string(),
        "invalid client command: snapshot boot ID required"
    );
}
