use super::*;

#[test]
fn fragmented_frames_survive_timeout_between_every_byte() {
    let (mut client, mut server) = Stream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_millis(1)))
        .unwrap();
    let expected = ServerMessage::TerminalBell { count: 300 };
    let bytes = encode_message(&expected, MAX_FRAME_SIZE).unwrap();
    let mut reader = FrameReader::new();
    let mut message = None;
    for byte in bytes {
        assert!(reader.poll(&mut client).unwrap().is_none()); // timeout, preserving state
        server.write_all(&[byte]).unwrap();
        if let Some(next) = reader.poll(&mut client).unwrap() {
            message = Some(next);
        }
    }
    assert_eq!(message, Some(expected));
}

#[test]
fn geometry_and_frame_reader_limits() {
    for (cols, rows, cell_width_px) in [(0, 24, 0), (4097, 1, 0), (1001, 1000, 0), (80, 24, 4097)] {
        assert!(
            validate_options(ConnectOptions {
                surface_size: ClientSurfaceSize { cols, rows },
                cell_width_px,
                cell_height_px: 0,
            })
            .is_err()
        );
    }
    let (mut client, mut server) = Stream::pair().unwrap();
    server
        .write_all(&((MAX_GRAPHICS_FRAME_SIZE + 1) as u32).to_le_bytes())
        .unwrap();
    assert!(FrameReader::new().poll(&mut client).is_err());
    let mut reader = FrameReader::new();
    reader.started = Some(Instant::now() - TIMEOUT - POLL);
    assert!(
        reader
            .poll(&mut client)
            .unwrap_err()
            .to_string()
            .contains("timed out")
    );
}

#[test]
fn frame_reader_accepts_read_trait_objects_and_preserves_partial_state() {
    struct Fragmented {
        bytes: io::Cursor<Vec<u8>>,
        pause: bool,
        error: io::ErrorKind,
    }
    impl Read for Fragmented {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.pause = !self.pause;
            if self.pause {
                return Err(self.error.into());
            }
            let len = buf.len().min(1);
            self.bytes.read(&mut buf[..len])
        }
    }
    let expected = ServerMessage::TerminalBell { count: 300 };
    let bytes = encode_message(&expected, MAX_FRAME_SIZE).unwrap();
    for error in [
        io::ErrorKind::WouldBlock,
        io::ErrorKind::TimedOut,
        io::ErrorKind::Interrupted,
    ] {
        let mut input = Fragmented {
            bytes: io::Cursor::new(bytes.repeat(2)),
            pause: false,
            error,
        };
        let input: &mut dyn Read = &mut input;
        let mut reader = FrameReader::new();
        for _ in 0..2 {
            for index in 0..bytes.len() {
                assert!(reader.poll(input).unwrap().is_none());
                let message = reader.poll(input).unwrap();
                if index + 1 == bytes.len() {
                    assert_eq!(message, Some(expected.clone()));
                    assert!(reader.started.is_none());
                    assert!(reader.bytes.is_empty());
                    assert_eq!(reader.target, 4);
                } else {
                    assert!(message.is_none());
                }
            }
        }
        assert!(reader.poll(input).unwrap().is_none());
        assert_eq!(
            reader.poll(input).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}

#[test]
fn read_batches_bound_progress_and_stop_on_the_first_idle_read() {
    struct Input {
        bytes: io::Cursor<Vec<u8>>,
        calls: usize,
        idle: Option<io::ErrorKind>,
    }
    impl Read for Input {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.calls += 1;
            if let Some(kind) = self.idle {
                return Err(kind.into());
            }
            self.bytes.read(bytes)
        }
    }
    let expected = ServerMessage::Graphics {
        bytes: vec![17; 2 * 1024 * 1024],
    };
    let mut input = Input {
        bytes: io::Cursor::new(encode_message(&expected, MAX_GRAPHICS_FRAME_SIZE).unwrap()),
        calls: 0,
        idle: None,
    };
    let mut reader = FrameReader::new();
    assert!(reader.poll_batch(&mut input).unwrap().is_none());
    assert!((1..=128).contains(&input.calls));
    assert!(reader.bytes.len() <= 1024 * 1024);
    let partial = reader.bytes.len();
    for kind in [
        io::ErrorKind::WouldBlock,
        io::ErrorKind::TimedOut,
        io::ErrorKind::Interrupted,
    ] {
        input.idle = Some(kind);
        input.calls = 0;
        assert!(reader.poll_batch(&mut input).unwrap().is_none());
        assert_eq!(input.calls, 1);
        assert_eq!(reader.bytes.len(), partial);
    }
    input.idle = None;
    loop {
        input.calls = 0;
        let message = reader.poll_batch(&mut input).unwrap();
        assert!(input.calls <= 128);
        if let Some(message) = message {
            assert_eq!(message, expected);
            break;
        }
    }
}
