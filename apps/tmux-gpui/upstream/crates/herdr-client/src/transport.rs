//! The client's local stream type, matching the endpoint each platform's Herdr
//! daemon actually binds: a filesystem `AF_UNIX` socket on Unix, and a named
//! pipe on Windows, where upstream maps the same socket path string into the
//! NPFS namespace. Discovery, framing, and the session loop stay identical; only
//! the stream underneath differs. On Windows a stream can also be a bridge
//! child's anonymous pipes, which take the same peek-based receive timeout.

#[cfg(unix)]
pub use std::os::unix::net::UnixStream as Stream;

#[cfg(all(test, unix))]
pub(crate) use std::os::unix::net::UnixListener as Listener;

#[cfg(windows)]
pub use windows::Stream;

#[cfg(windows)]
mod windows {
    use interprocess::local_socket::{
        GenericNamespaced, Stream as LocalStream, ToNsName, traits::Stream as _,
    };
    use std::{
        io::{self, Read, Write},
        os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle},
        path::Path,
        process::{ChildStdin, ChildStdout},
        thread,
        time::{Duration, Instant},
    };

    /// How long an idle read sleeps before peeking again. Well below the 10 ms
    /// transport poll, so an emulated receive timeout stays accurate.
    const RETRY: Duration = Duration::from_millis(1);

    /// A connected Herdr client endpoint. Owns the pipe and the receive timeout
    /// the caller set, which the pipe itself cannot hold.
    #[derive(Debug)]
    pub struct Stream {
        pipe: Pipe,
        read_timeout: Option<Duration>,
    }

    /// The daemon's named pipe, or a bridge child's standard streams, one
    /// anonymous pipe each way. Both answer `PeekNamedPipe`.
    #[derive(Debug)]
    enum Pipe {
        Named(LocalStream),
        Child {
            stdin: ChildStdin,
            stdout: ChildStdout,
        },
    }

    impl Pipe {
        fn readable(&self) -> BorrowedHandle<'_> {
            match self {
                Self::Named(LocalStream::NamedPipe(pipe)) => pipe.as_handle(),
                Self::Child { stdout, .. } => stdout.as_handle(),
            }
        }
    }

    /// Upstream derives the pipe name from the socket path exactly this way, so
    /// both ends agree without either of them owning a file at that path.
    fn connect(path: &Path) -> io::Result<LocalStream> {
        let name = path.to_string_lossy().into_owned();
        let name = name.to_ns_name::<GenericNamespaced>().inspect_err(|error| {
            tracing::warn!(operation = "pipe_name", kind = ?error.kind(), raw_os_error = ?error.raw_os_error(), "Windows local transport failed");
        })?;
        LocalStream::connect(name).inspect_err(|error| {
            // Keep native codes without recording the user's socket path. The
            // byte-mode connector opens the pipe without changing its read mode.
            tracing::warn!(operation = "pipe_connect", kind = ?error.kind(), raw_os_error = ?error.raw_os_error(), "Windows local transport failed");
        })
    }

    /// Whether an error means the pipe is gone rather than merely idle. Mirrors
    /// the set the daemon's own client treats as a disconnect, including the
    /// raw codes whose `ErrorKind` mapping is not specific enough.
    fn closed(error: &io::Error) -> bool {
        matches!(
            error.kind(),
            io::ErrorKind::BrokenPipe
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::ConnectionReset
                | io::ErrorKind::NotConnected
                | io::ErrorKind::UnexpectedEof
                | io::ErrorKind::WriteZero
        ) || matches!(error.raw_os_error(), Some(6 | 109 | 232 | 233))
    }

    /// Bytes already buffered on the pipe, or `None` once the peer closed it.
    ///
    /// A named pipe exposes neither a pollable descriptor nor a receive timeout,
    /// and `PIPE_NOWAIT` is no help: it reports "no data yet" as `ERROR_NO_DATA`,
    /// which the standard library maps to `BrokenPipe` and `interprocess` then
    /// downgrades to a zero-length read. Reading an idle connection would
    /// therefore look exactly like a disconnect. Peeking first is what the
    /// daemon's own Windows client does, and no safe wrapper exposes it. A
    /// bridge child's anonymous pipe has the same limits, and `PeekNamedPipe`
    /// documents accepting it too.
    #[allow(unsafe_code)]
    fn available(pipe: BorrowedHandle<'_>) -> io::Result<Option<u32>> {
        let mut ready: u32 = 0;
        // SAFETY: the handle is borrowed from a pipe that outlives this call.
        // `lpBuffer`/`lpBytesRead`/`lpBytesLeftThisMessage` are documented as
        // optional and passed as null with a zero buffer size, so nothing is
        // copied out. `ready` is a live, exclusively borrowed `u32` that the
        // call writes only on success, and the return value is checked before
        // it is read.
        let peeked = unsafe {
            windows_sys::Win32::System::Pipes::PeekNamedPipe(
                pipe.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut ready,
                std::ptr::null_mut(),
            )
        };
        if peeked != 0 {
            return Ok(Some(ready));
        }
        let error = io::Error::last_os_error();
        if closed(&error) {
            Ok(None)
        } else {
            tracing::warn!(operation = "pipe_peek", kind = ?error.kind(), raw_os_error = ?error.raw_os_error(), "Windows local transport failed");
            Err(error)
        }
    }

    /// Sleeps until the next peek, or reports the elapsed deadline the way a
    /// socket receive timeout would, so callers need not know which transport
    /// they hold.
    fn wait(deadline: Option<Instant>) -> io::Result<()> {
        let Some(deadline) = deadline else {
            thread::sleep(RETRY);
            return Ok(());
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        thread::sleep(remaining.min(RETRY));
        Ok(())
    }

    impl Stream {
        pub fn connect(path: impl AsRef<Path>) -> io::Result<Self> {
            Ok(Self::wrap(connect(path.as_ref())?))
        }

        /// A bridge child's standard streams as one endpoint stream. The child
        /// itself stays with the caller, which kills and reaps it.
        pub(crate) fn from_child(stdin: ChildStdin, stdout: ChildStdout) -> Self {
            Self {
                pipe: Pipe::Child { stdin, stdout },
                read_timeout: None,
            }
        }

        fn wrap(pipe: LocalStream) -> Self {
            Self {
                pipe: Pipe::Named(pipe),
                read_timeout: None,
            }
        }

        pub fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
            self.read_timeout = timeout;
            Ok(())
        }

        /// Accepted for parity with the Unix socket and deliberately not stored:
        /// a named pipe has no send timeout, and nothing here could honor one.
        /// A peer that stops reading can therefore block a write until it exits.
        pub fn set_write_timeout(&mut self, _timeout: Option<Duration>) -> io::Result<()> {
            Ok(())
        }

        /// A connected pair over a private pipe, for tests. The listener already
        /// holds the first instance, so the connect below has one to accept.
        pub fn pair() -> io::Result<(Self, Self)> {
            use interprocess::local_socket::{ListenerOptions, traits::Listener as _};
            use std::sync::atomic::{AtomicU64, Ordering};

            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "herdr-pair-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let name = path.to_string_lossy().into_owned();
            let listener = ListenerOptions::new()
                .name(name.to_ns_name::<GenericNamespaced>()?)
                .create_sync()?;
            let client = connect(&path)?;
            let server = listener.accept()?;
            Ok((Self::wrap(server), Self::wrap(client)))
        }
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if buf.is_empty() {
                return Ok(0);
            }
            let deadline = self.read_timeout.map(|timeout| Instant::now() + timeout);
            loop {
                match available(self.pipe.readable())? {
                    // Report a closed peer as end of stream, as a socket does.
                    None => return Ok(0),
                    Some(0) => {}
                    // The pipe holds these bytes already, so this cannot block.
                    Some(ready) => {
                        let len = buf.len().min(ready as usize);
                        return match &mut self.pipe {
                            Pipe::Named(pipe) => pipe.read(&mut buf[..len]),
                            Pipe::Child { stdout, .. } => stdout.read(&mut buf[..len]),
                        };
                    }
                }
                wait(deadline)?;
            }
        }
    }

    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            match &mut self.pipe {
                Pipe::Named(pipe) => pipe.write(buf),
                Pipe::Child { stdin, .. } => stdin.write(buf),
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            match &mut self.pipe {
                Pipe::Named(pipe) => pipe.flush(),
                Pipe::Child { stdin, .. } => stdin.flush(),
            }
        }
    }
}

#[cfg(all(test, windows))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
