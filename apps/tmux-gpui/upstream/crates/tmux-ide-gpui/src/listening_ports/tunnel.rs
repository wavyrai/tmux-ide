//! SSH tunnels that make a remote server listening only on its host's own
//! loopback reachable from a browser tab here. One `ssh -N -L` child per
//! remote port, started when its port is clicked and kept while the port is
//! still listed, so reopening the page reuses it.

use crate::{Error, Result};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read},
    net::{Ipv4Addr, TcpListener},
    process::{Child, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

/// SSH connects, authenticates, and binds within its own `ConnectTimeout`.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// Under `-N`, SSH's stdout carries only the readiness line, perhaps after
/// whatever the user's shell prints when it runs `LocalCommand`.
const READY_OUTPUT: u64 = 64 * 1024;
/// Tunnels are opened by hand, one click each; this only bounds a runaway.
const TUNNEL_LIMIT: usize = 32;

/// A remote port, by the SSH target its host is dialled with.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Key {
    pub target: String,
    pub port: u16,
}

/// A running `ssh -N -L` child and the local port it forwards.
pub(crate) struct Tunnel {
    child: Option<Child>,
    local: u16,
}

impl Tunnel {
    /// Whether the child is still forwarding. Never blocks.
    fn alive(&mut self) -> bool {
        self.child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }
}

impl Drop for Tunnel {
    /// Kills the child and reaps it on a thread of its own, so closing a
    /// tunnel never waits on the UI thread.
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.kill();
        let reaped = thread::Builder::new()
            .name("herdr-tunnel-reaper".into())
            .spawn(move || {
                let _ = child.wait();
            });
        if let Err(error) = reaped {
            tracing::warn!(category = "listening-ports", %error, "could not reap an SSH tunnel");
        }
    }
}

/// Starts a tunnel to `key` and waits until SSH says its forward is bound,
/// which blocks for up to [`OPEN_TIMEOUT`]: call it off the UI thread.
/// `preferred` is the local port this remote port was last forwarded to,
/// kept when it is still free so a page reopened after a dropped connection
/// keeps its address.
pub(crate) fn open(key: &Key, preferred: Option<u16>) -> Result<Tunnel> {
    match start(key, preferred) {
        // Someone took the remembered port meanwhile; any free one will do.
        Err(Error::TunnelExited(_)) if preferred.is_some() => start(key, None),
        result => result,
    }
}

fn start(key: &Key, preferred: Option<u16>) -> Result<Tunnel> {
    let local = free_port(preferred).map_err(Error::TunnelPort)?;
    let mut command = herdr_client::forward_command(&key.target, local, key.port)?;
    // Only the readiness line is read; diagnostics may carry secrets.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(Error::TunnelStart)?;
    let stdout = child.stdout.take();
    // From here on, dropping the tunnel kills the child.
    let mut tunnel = Tunnel {
        child: Some(child),
        local,
    };
    let (Some(stdout), Some(child)) = (stdout, tunnel.child.as_mut()) else {
        return Err(Error::TunnelStart(std::io::Error::other("no stdout pipe")));
    };
    ready(child, stdout, Instant::now() + OPEN_TIMEOUT)?;
    Ok(tunnel)
}

/// Waits for `child` to print [`herdr_client::FORWARD_READY`]. The port
/// itself is never probed: a process that bound it before SSH could would
/// answer a probe, and a page opened then would show that process instead.
/// SSH prints the line only once it holds the port.
pub(super) fn ready(
    child: &mut Child,
    stdout: impl Read + Send + 'static,
    deadline: Instant,
) -> Result<()> {
    let (sender, found) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("herdr-tunnel-ready".into())
        .spawn(move || {
            let ready = BufReader::new(stdout.take(READY_OUTPUT))
                .lines()
                .map_while(std::io::Result::ok)
                .any(|line| line.trim_end() == herdr_client::FORWARD_READY);
            let _ = sender.send(ready);
        })
        .map_err(Error::TunnelStart)?;
    let mut closed = false;
    loop {
        if closed {
            thread::sleep(POLL_INTERVAL);
        } else {
            match found.recv_timeout(POLL_INTERVAL) {
                Ok(true) => return Ok(()),
                // Output ended without the line: the child is exiting.
                Ok(false) | Err(mpsc::RecvTimeoutError::Disconnected) => closed = true,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        if let Some(status) = child.try_wait().map_err(Error::TunnelStart)? {
            return Err(Error::TunnelExited(status));
        }
        if Instant::now() >= deadline {
            return Err(Error::TunnelTimeout);
        }
    }
}

/// A loopback port nobody listens on, `preferred` when it is free. The
/// listener is closed before `ssh` binds the port; another process taking it
/// in between makes `ssh` exit before it reports ready, so [`open`] fails
/// rather than opening the other process's page.
pub(super) fn free_port(preferred: Option<u16>) -> std::io::Result<u16> {
    pick(preferred, |port| {
        TcpListener::bind((Ipv4Addr::LOCALHOST, port))?
            .local_addr()
            .map(|address| address.port())
    })
}

/// `preferred` when `bind` takes it, else whatever port `bind(0)` gets.
pub(super) fn pick(
    preferred: Option<u16>,
    mut bind: impl FnMut(u16) -> std::io::Result<u16>,
) -> std::io::Result<u16> {
    match preferred.map(&mut bind) {
        Some(Ok(port)) => Ok(port),
        _ => bind(0),
    }
}

/// This window's tunnels, and the ones still opening.
#[derive(Default)]
pub(crate) struct Tunnels {
    open: HashMap<Key, Tunnel>,
    opening: HashSet<Key>,
    /// The local port each remote port was last forwarded to.
    used: HashMap<Key, u16>,
}

impl Tunnels {
    /// The local port of a live tunnel to `key`; a dead one is dropped.
    pub(crate) fn local(&mut self, key: &Key) -> Option<u16> {
        let tunnel = self.open.get_mut(key)?;
        if tunnel.alive() {
            return Some(tunnel.local);
        }
        self.open.remove(key);
        None
    }

    /// Marks `key` as opening and returns the local port to prefer, or None
    /// when it is opening already or too many tunnels are.
    pub(crate) fn begin(&mut self, key: &Key) -> Option<Option<u16>> {
        if self.open.len() + self.opening.len() >= TUNNEL_LIMIT || !self.opening.insert(key.clone())
        {
            return None;
        }
        Some(self.used.get(key).copied())
    }

    /// Records a finished attempt. A tunnel nobody wants any more, because
    /// its port closed while it was opening, is dropped and None returned.
    pub(crate) fn finish(&mut self, key: Key, tunnel: Tunnel) -> Option<u16> {
        if !self.opening.remove(&key) {
            return None;
        }
        let local = tunnel.local;
        // A local port belongs to one remote port at a time, so a page left
        // open on another remote port's old address is never handed this one.
        self.used.retain(|_, used| *used != local);
        self.used.insert(key.clone(), local);
        self.open.insert(key, tunnel);
        Some(local)
    }

    pub(crate) fn fail(&mut self, key: &Key) {
        self.opening.remove(key);
    }

    /// Closes every tunnel whose remote port `listening` no longer lists,
    /// and forgets those still opening, so their result is dropped too.
    pub(crate) fn retain(&mut self, mut listening: impl FnMut(&Key) -> bool) {
        self.open.retain(|key, _| listening(key));
        self.opening.retain(|key| listening(key));
        self.used.retain(|key, _| listening(key));
    }

    #[cfg(all(test, unix))]
    pub(crate) fn insert(&mut self, key: Key, tunnel: Tunnel) {
        self.open.insert(key, tunnel);
    }

    #[cfg(all(test, unix))]
    pub(crate) fn len(&self) -> usize {
        self.open.len()
    }
}

#[cfg(all(test, unix))]
impl Tunnel {
    /// A tunnel around any child, standing in for `ssh` in tests.
    pub(crate) fn around(child: Child, local: u16) -> Self {
        Self {
            child: Some(child),
            local,
        }
    }
}
