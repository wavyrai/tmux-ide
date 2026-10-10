//! The ordered command queue between a handle and its connection worker. The
//! worker otherwise waits in a socket read, so queueing a command also wakes
//! it: input goes out when it is typed, not when that read times out.

use crate::{Error, Result, handle::Command, transport::Stream};
use crossbeam_channel::{Receiver, Sender, TryRecvError, TrySendError};
use std::{io, time::Duration};

/// Create a queue that holds at most `capacity` commands.
pub(crate) fn channel(capacity: usize) -> io::Result<(CommandSender, CommandReceiver)> {
    let (sender, receiver) = crossbeam_channel::bounded(capacity);
    let (wake, wait) = wake_pair()?;
    Ok((
        CommandSender { sender, wake },
        CommandReceiver { receiver, wait },
    ))
}

pub(crate) struct CommandSender {
    sender: Sender<Command>,
    wake: Wake,
}

impl CommandSender {
    /// Queueing is never daemon acknowledgement.
    pub(crate) fn try_send(&self, command: Command) -> Result<()> {
        self.sender.try_send(command).map_err(|error| match error {
            TrySendError::Full(_) => {
                tracing::warn!(category = "command_queue", "client backpressure");
                Error::Full
            }
            TrySendError::Disconnected(_) => Error::Disconnected,
        })?;
        self.wake.wake();
        Ok(())
    }

    /// Wake the worker without queueing, so it observes a stop promptly.
    pub(crate) fn wake(&self) {
        self.wake.wake();
    }
}

pub(crate) struct CommandReceiver {
    receiver: Receiver<Command>,
    wait: Wait,
}

impl CommandReceiver {
    pub(crate) fn try_recv(&self) -> std::result::Result<Command, TryRecvError> {
        self.receiver.try_recv()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.receiver.is_empty()
    }

    /// Block until `stream` is readable, a command is queued, or `timeout`
    /// passes. Returns whether a read of `stream` will not wait.
    pub(crate) fn wait(&self, stream: &Stream, timeout: Duration) -> Result<bool> {
        self.wait.wait(stream, timeout)
    }
}

#[cfg(unix)]
use unix::{Wait, Wake, pair as wake_pair};
#[cfg(windows)]
use windows::{Wait, Wake, pair as wake_pair};

#[cfg(unix)]
mod unix {
    use crate::{Result, transport::Stream};
    use rustix::event::{PollFd, PollFlags, Timespec, poll};
    use std::{
        io::{self, Read, Write},
        os::unix::net::UnixStream,
        time::Duration,
    };

    /// Each end is non-blocking: a full buffer already holds a pending wake,
    /// and draining must never block the worker.
    pub(super) fn pair() -> io::Result<(Wake, Wait)> {
        let (wake, wait) = UnixStream::pair()?;
        wake.set_nonblocking(true)?;
        wait.set_nonblocking(true)?;
        Ok((Wake(wake), Wait(wait)))
    }

    pub(super) struct Wake(UnixStream);

    impl Wake {
        pub(super) fn wake(&self) {
            // Best effort by design: `WouldBlock` means a wake is already
            // pending, and a closed peer means no worker is left to wake. The
            // worker's bounded poll timeout covers anything else.
            let _ = (&self.0).write(&[1]);
        }
    }

    pub(super) struct Wait(UnixStream);

    impl Wait {
        pub(super) fn wait(&self, stream: &Stream, timeout: Duration) -> Result<bool> {
            // Saturate: an unrepresentable timeout means waiting indefinitely.
            let timeout = Timespec::try_from(timeout).unwrap_or(Timespec {
                tv_sec: i64::MAX,
                tv_nsec: 0,
            });
            let mut fds = [
                PollFd::new(stream, PollFlags::IN),
                PollFd::new(&self.0, PollFlags::IN),
            ];
            match poll(&mut fds, Some(&timeout)) {
                Ok(_) => {}
                Err(rustix::io::Errno::INTR) => return Ok(false),
                Err(error) => return Err(io::Error::from(error).into()),
            }
            // Hang-up and error count as readable so the read reports them.
            let readable = !fds[0].revents().is_empty();
            if !fds[1].revents().is_empty() {
                self.drain()?;
            }
            Ok(readable)
        }

        /// One wake stands for every command queued so far; the worker drains
        /// the whole queue before it waits again.
        fn drain(&self) -> io::Result<()> {
            let mut buf = [0; 64];
            loop {
                match (&self.0).read(&mut buf) {
                    // The handle is gone; it set `stop` before dropping its end.
                    Ok(0) => return Ok(()),
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
}

/// A named pipe has no descriptor to poll beside a wake, so the worker keeps
/// relying on the stream's emulated receive timeout to notice queued commands.
#[cfg(windows)]
mod windows {
    use crate::{Result, transport::Stream};
    use std::{io, time::Duration};

    pub(super) fn pair() -> io::Result<(Wake, Wait)> {
        Ok((Wake, Wait))
    }

    pub(super) struct Wake;

    impl Wake {
        pub(super) fn wake(&self) {}
    }

    pub(super) struct Wait;

    impl Wait {
        pub(super) fn wait(&self, _: &Stream, _: Duration) -> Result<bool> {
            Ok(true)
        }
    }
}

#[cfg(all(test, unix))]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::{io::Write, thread, time::Instant};

    fn command() -> Command {
        Command {
            boot_id: "boot".into(),
            bytes: vec![1],
            request: None,
            image: None,
        }
    }

    #[test]
    fn a_queued_command_ends_the_wait_on_an_idle_stream() {
        let (stream, _peer) = Stream::pair().unwrap();
        let (sender, receiver) = channel(1).unwrap();
        let waiter = thread::spawn(move || {
            let start = Instant::now();
            let readable = receiver.wait(&stream, Duration::from_secs(60)).unwrap();
            (readable, start.elapsed(), receiver)
        });
        sender.try_send(command()).unwrap();
        let (readable, elapsed, receiver) = waiter.join().unwrap();
        // Far below the timeout: the wake, not the timeout, ended the wait.
        assert!(elapsed < Duration::from_secs(30), "{elapsed:?}");
        assert!(!readable, "an idle stream is not readable");
        assert!(receiver.try_recv().is_ok());
    }

    #[test]
    fn wakes_coalesce_and_are_drained_by_one_wait() {
        let (stream, _peer) = Stream::pair().unwrap();
        let (sender, receiver) = channel(1).unwrap();
        for _ in 0..1000 {
            sender.wake();
        }
        assert!(!receiver.wait(&stream, Duration::ZERO).unwrap());
        // Nothing is left to wake the next wait: it runs to its timeout.
        let start = Instant::now();
        assert!(!receiver.wait(&stream, Duration::from_millis(20)).unwrap());
        assert!(start.elapsed() >= Duration::from_millis(20));
    }

    #[test]
    fn inbound_data_and_hang_up_report_the_stream_readable() {
        let (stream, mut peer) = Stream::pair().unwrap();
        let (_sender, receiver) = channel(1).unwrap();
        peer.write_all(&[0]).unwrap();
        assert!(receiver.wait(&stream, Duration::from_secs(60)).unwrap());
        let (stream, peer) = Stream::pair().unwrap();
        drop(peer);
        assert!(receiver.wait(&stream, Duration::from_secs(60)).unwrap());
    }

    #[test]
    fn a_full_queue_does_not_wake_the_worker() {
        let (stream, _peer) = Stream::pair().unwrap();
        let (sender, receiver) = channel(1).unwrap();
        sender.try_send(command()).unwrap();
        assert!(!receiver.wait(&stream, Duration::ZERO).unwrap());
        assert!(matches!(sender.try_send(command()), Err(Error::Full)));
        let start = Instant::now();
        assert!(!receiver.wait(&stream, Duration::from_millis(20)).unwrap());
        assert!(start.elapsed() >= Duration::from_millis(20));
    }
}
