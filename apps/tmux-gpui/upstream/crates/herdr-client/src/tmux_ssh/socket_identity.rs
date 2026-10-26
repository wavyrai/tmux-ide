//! Prove identity on a caller-owned socket before its WebSocket upgrade. ureq
//! supplies HTTP framing, including chunked bodies; no credentials enter this probe.
use super::PeerIdentity;
use std::{
    io::{self, Read, Write},
    net::TcpStream,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use ureq::unversioned::{
    resolver::DefaultResolver,
    transport::{Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport},
};
#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("Remote socket identity I/O failed")]
    Io(#[from] io::Error),
    #[error("Remote socket identity request failed")]
    Http(#[source] ureq::Error),
    #[error("Remote socket identity did not match")]
    Mismatch,
    #[error("Remote socket identity response has unexpected trailing bytes")]
    Trailing,
}
#[derive(Debug)]
struct PinnedConnector {
    socket: Mutex<Option<TcpStream>>,
    authority: String,
    trailing: Arc<AtomicBool>,
}
impl Connector for PinnedConnector {
    type Out = SocketTransport;
    fn connect(
        &self,
        details: &ConnectionDetails,
        _: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        if details.uri.scheme_str() != Some("http")
            || details.uri.authority().map(|a| a.as_str()) != Some(self.authority.as_str())
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "identity endpoint changed",
            )
            .into());
        }
        let socket = self
            .socket
            .lock()
            .map_err(|_| io::Error::other("identity connector poisoned"))?
            .take()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "identity socket cannot be replaced",
                )
            })?;
        Ok(Some(SocketTransport {
            socket,
            buffers: LazyBuffers::new(4096, 4096),
            trailing: self.trailing.clone(),
        }))
    }
}
#[derive(Debug)]
struct SocketTransport {
    socket: TcpStream,
    buffers: LazyBuffers,
    trailing: Arc<AtomicBool>,
}
impl Drop for SocketTransport {
    fn drop(&mut self) {
        if !self.buffers.input().is_empty() {
            self.trailing.store(true, Ordering::Release);
        }
    }
}
impl Transport for SocketTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }
    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.socket
            .set_write_timeout(timeout.not_zero().map(|d| *d))?;
        self.socket
            .write_all(&self.buffers.output()[..amount])
            .map_err(Into::into)
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.socket
            .set_read_timeout(timeout.not_zero().map(|d| *d))?;
        let count = self.socket.read(self.buffers.input_append_buf())?;
        self.buffers.input_appended(count);
        Ok(count > 0)
    }
    fn is_open(&mut self) -> bool {
        true
    }
}
/// Worker-only. The caller must discard the socket on any error. Cancellation can
/// shutdown another clone of this socket to interrupt the bounded blocking probe.
/// Leaves a successful socket nonblocking for the existing terminal worker.
pub fn verify_socket_identity(
    socket: &TcpStream,
    expected: &PeerIdentity,
    timeout: Duration,
) -> Result<(), IdentityError> {
    let address = socket.peer_addr()?;
    if !address.ip().is_loopback() || timeout.is_zero() {
        return Err(IdentityError::Mismatch);
    }
    socket.set_nonblocking(false)?;
    let trailing = Arc::new(AtomicBool::new(false));
    let authority = address.to_string();
    let config = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .build();
    let agent = ureq::Agent::with_parts(
        config,
        PinnedConnector {
            socket: Mutex::new(Some(socket.try_clone()?)),
            authority: authority.clone(),
            trailing: trailing.clone(),
        },
        DefaultResolver::default(),
    );
    let mut response = agent
        .get(format!("http://{authority}/identity"))
        .call()
        .map_err(IdentityError::Http)?;
    if response.status().as_u16() != 200 {
        return Err(IdentityError::Mismatch);
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_vec()
        .map_err(IdentityError::Http)?;
    if !expected.matches(&bytes) {
        return Err(IdentityError::Mismatch);
    }
    drop(response);
    drop(agent);
    if trailing.load(Ordering::Acquire) {
        return Err(IdentityError::Trailing);
    }
    socket.set_read_timeout(None)?;
    socket.set_write_timeout(None)?;
    socket.set_nonblocking(true)?;
    Ok(())
}
#[cfg(test)]
#[path = "socket_identity_tests.rs"]
mod tests;
