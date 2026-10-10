use super::*;
use crate::frame::ImageWriter;

#[test]
fn image_writer_preserves_offsets_through_short_writes_and_timeouts() {
    struct ShortWriter {
        bytes: Vec<u8>,
        calls: usize,
    }
    impl Write for ShortWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            assert!(bytes.len() <= 64 * 1024);
            self.calls += 1;
            match self.calls % 4 {
                0 => Err(io::ErrorKind::TimedOut.into()),
                1 => Err(io::ErrorKind::Interrupted.into()),
                2 => Err(io::ErrorKind::WouldBlock.into()),
                _ => {
                    let n = bytes.len().min(997);
                    self.bytes.extend_from_slice(&bytes[..n]);
                    Ok(n)
                }
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("must not flush a partial image")
        }
    }
    let bytes = encode_clipboard_image(
        ClientClipboardImageTarget::Popup("popup".into()),
        "PNG",
        vec![42; MAX_FRAME_SIZE + 1],
    )
    .unwrap();
    let mut stream = ShortWriter {
        bytes: Vec::new(),
        calls: 0,
    };
    let mut writer = ImageWriter::default();
    for _ in 0..20_000 {
        if writer.poll(&mut stream, &bytes).unwrap() {
            break;
        }
    }
    assert_eq!(stream.bytes, bytes);
    writer.started = Some(Instant::now() - COMMAND_TIMEOUT);
    assert!(matches!(
        writer.check_timeout(),
        Err(Error::ClipboardImageWriteTimeout)
    ));
}

#[cfg(windows)]
#[test]
fn images_refuse_unbounded_pipe_writes() {
    let (client, _server, worker) = test_client();
    assert!(matches!(
        client
            .handle
            .reserve_clipboard_image("boot", ClientClipboardImageTarget::DirectTerminal),
        Err(Error::ClipboardImageUnsupported)
    ));
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[cfg(unix)]
mod unix;
