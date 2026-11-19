//! attach-rtt: two ways a stream opens sooner over SSH.
//!
//! A [`PreparedSocket`] is the stream's TCP connection, dialed through the SSH
//! forward and identity-proven while the open and the issue requests are
//! still in flight, so the stream does not pay the channel open and the proof
//! after them. The proof is the same one the stream makes on a socket it dials
//! itself, on this very socket, before any credential is written to it.
//!
//! `redeem_in_upgrade` sends the redeem frame in the upgrade request, so a
//! daemon that says `X-Tmux-Ide-Redeem: accepted` streams without waiting a
//! round trip for the frame.
use crate::tmux_ssh::PeerIdentity;
use std::{
    io,
    net::{Ipv4Addr, SocketAddr, TcpStream},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

/// What the stream may use when it opens. Empty: dial and redeem as before.
#[derive(Default)]
pub struct UpgradeHints {
    pub prepared: Option<PreparedSocket>,
    pub redeem_in_upgrade: bool,
}

/// After its proof the daemon keeps an unauthenticated connection idle for
/// 5 s (Node's default); use a prepared socket only well inside that.
const FRESH: Duration = Duration::from_secs(3);

/// A socket being dialed and proven on its own thread. Dropping it closes it.
pub struct PreparedSocket {
    port: u16,
    peer: PeerIdentity,
    ready: mpsc::Receiver<io::Result<(TcpStream, Instant)>>,
}

impl PreparedSocket {
    /// Dial the forward on `port` and prove `peer` on it, off the caller.
    pub(crate) fn spawn(port: u16, peer: PeerIdentity, timeout: Duration) -> Self {
        let (sender, ready) = mpsc::sync_channel(1);
        let expected = peer.clone();
        let started = thread::Builder::new()
            .name("tmux-stream-prepare".into())
            .spawn(move || {
                let proven = (|| {
                    let socket = TcpStream::connect_timeout(
                        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
                        timeout,
                    )?;
                    socket.set_nodelay(true)?;
                    socket.set_nonblocking(true)?;
                    crate::tmux_ssh::verify_socket_identity(&socket, &expected, timeout)
                        .map_err(io::Error::other)?;
                    Ok((socket, Instant::now()))
                })();
                let _ = sender.send(proven);
            });
        if let Err(error) = started {
            let (sender, failed) = mpsc::sync_channel(1);
            let _ = sender.send(Err(error));
            return Self {
                port,
                peer,
                ready: failed,
            };
        }
        Self { port, peer, ready }
    }

    /// The proven socket, when it is for this port and peer, proved within
    /// `wait`, is still fresh and has not been closed by the daemon. Anything
    /// else is `None`, and the caller dials as it always did.
    pub(crate) fn take(self, port: u16, peer: &PeerIdentity, wait: Duration) -> Option<TcpStream> {
        if self.port != port || &self.peer != peer {
            return None;
        }
        let (socket, proven_at) = self.ready.recv_timeout(wait).ok()?.ok()?;
        if proven_at.elapsed() > FRESH || closed(&socket) {
            return None;
        }
        Some(socket)
    }
}

/// A nonblocking peek: end of stream means the daemon closed it; unread
/// bytes on a socket that has not upgraded yet are not ours to accept either.
fn closed(socket: &TcpStream) -> bool {
    let mut byte = [0];
    !matches!(socket.peek(&mut byte), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
}

#[cfg(test)]
#[path = "upgrade_tests.rs"]
mod tests;
