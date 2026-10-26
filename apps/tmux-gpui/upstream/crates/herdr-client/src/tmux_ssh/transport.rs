//! Worker-owned remote route: discovery, forward lifetime and authenticated HTTP.
//! A replacement route is explicit; no remote daemon bootstrap or action replay.
use super::{
    ConnectionError, DiscoveryError, RemoteDescriptor, SshTarget, Tunnel, TunnelError,
    VerifiedConnection, discover,
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error(transparent)]
    Discovery(#[from] DiscoveryError),
    #[error(transparent)]
    Tunnel(#[from] TunnelError),
    #[error(transparent)]
    Connection(#[from] ConnectionError),
    #[error("SSH connection was cancelled")]
    Cancelled,
    #[error("SSH connection deadline expired")]
    Timeout,
}
/// Keep on the catalog worker, not a GPUI entity. Dropping the route closes its
/// HTTP pool and asynchronously retires its tunnel. Remote processes stay alive.
pub struct RemoteTransport {
    connection: Mutex<Option<VerifiedConnection>>,
    descriptor: Arc<RemoteDescriptor>,
    tunnel: Arc<Tunnel>,
    generation: uuid::Uuid,
}
impl RemoteTransport {
    pub fn connect(
        target: &SshTarget,
        expected_environment: Option<&str>,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<Self, TransportError> {
        check(cancelled, deadline)?;
        let descriptor = Arc::new(discover(target, expected_environment, cancelled, deadline)?);
        check(cancelled, deadline)?;
        let tunnel = Tunnel::spawn(target, &descriptor)?;
        Self::finish_connect(tunnel, descriptor, cancelled, deadline)
    }
    fn finish_connect(
        tunnel: Tunnel,
        descriptor: Arc<RemoteDescriptor>,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<Self, TransportError> {
        let result = (|| loop {
            check(cancelled, deadline)?;
            tunnel.check()?;
            let timeout = deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(2500));
            let result =
                VerifiedConnection::connect_shared(tunnel.port(), descriptor.clone(), timeout);
            check(cancelled, deadline)?;
            tunnel.check()?;
            match result {
                Ok(connection) => return Ok(connection),
                // Startup may precede SSH's listener. Every attempt still starts
                // without credentials and must prove identity on its own socket.
                Err(ConnectionError::Network(_)) => thread::sleep(
                    Duration::from_millis(20)
                        .min(deadline.saturating_duration_since(Instant::now())),
                ),
                Err(error) => return Err(error.into()),
            }
        })();
        match result {
            Ok(connection) => Ok(Self {
                connection: Mutex::new(Some(connection)),
                descriptor,
                tunnel: Arc::new(tunnel),
                generation: uuid::Uuid::new_v4(),
            }),
            Err(error) => {
                tunnel.shutdown()?;
                Err(error)
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn fixture(port: u16, descriptor: RemoteDescriptor) -> Result<Self, TransportError> {
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("60");
        let tunnel = Tunnel::spawn_command(command, port)?;
        Self::finish_connect(
            tunnel,
            Arc::new(descriptor),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(3),
        )
    }
    #[cfg(test)]
    pub(crate) fn shutdown_fixture(self) -> Result<(), TunnelError> {
        drop(self.connection);
        Arc::try_unwrap(self.tunnel)
            .map_err(|_| TunnelError::Worker)?
            .shutdown()
    }
    pub(crate) fn catalog_watch_endpoint(
        &self,
    ) -> Result<crate::tmux_daemon::CatalogWatchEndpoint, TransportError> {
        self.tunnel.check()?;
        let mut authorization =
            tungstenite::http::HeaderValue::from_str(&self.descriptor.authorization())
                .map_err(|_| ConnectionError::Path)?;
        authorization.set_sensitive(true);
        Ok(crate::tmux_daemon::CatalogWatchEndpoint {
            address: std::net::SocketAddr::from(([127, 0, 0, 1], self.tunnel.port())),
            peer: self.descriptor.peer_identity(),
            identity: self.descriptor.catalog_identity(),
            authorization,
        })
    }
    pub(crate) fn capability_route(
        &self,
    ) -> Result<(url::Url, u16, super::PeerIdentity), TransportError> {
        self.tunnel.check()?;
        let origin = url::Url::parse(&format!("http://{}/", self.descriptor.forward_target()))
            .map_err(|_| ConnectionError::Path)?;
        Ok((origin, self.tunnel.port(), self.descriptor.peer_identity()))
    }
    /// Independent HTTP lane on the same SSH owner/generation. Slow metadata
    /// requests cannot hold the foreground lane's connection lock.
    pub(crate) fn fork(&self) -> Result<Self, TransportError> {
        self.tunnel.check()?;
        // Reuse an idle proof connection when available; never wait for another
        // lane's in-flight request just to create a foreground lane.
        let connection = match self.connection.try_lock() {
            Ok(mut slot) => slot.take(),
            Err(std::sync::TryLockError::WouldBlock) => None,
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(TunnelError::Worker.into()),
        };
        Ok(Self {
            connection: Mutex::new(connection),
            descriptor: self.descriptor.clone(),
            tunnel: self.tunnel.clone(),
            generation: self.generation,
        })
    }
    pub(crate) fn instance_id(&self) -> &str {
        self.descriptor.instance_id()
    }
    pub(crate) fn environment_id(&self) -> Option<&str> {
        self.descriptor.environment_id()
    }
    pub fn generation(&self) -> uuid::Uuid {
        self.generation
    }
    pub(crate) fn shutdown_owned(&self) -> Result<(), TransportError> {
        self.tunnel.retire();
        self.tunnel.wait_closed(Duration::from_secs(3))?;
        Ok(())
    }
    pub fn retire(&self) {
        self.tunnel.retire();
    }
    pub fn capabilities(&self, cancelled: &AtomicBool) -> Result<Vec<u8>, TransportError> {
        if cancelled.load(Ordering::Acquire) {
            return Err(TransportError::Cancelled);
        }
        let result = self.get_resource("api/v2/capabilities");
        if cancelled.load(Ordering::Acquire) {
            return Err(TransportError::Cancelled);
        }
        result
    }
    fn request(
        &self,
        action: impl FnOnce(&VerifiedConnection) -> Result<Vec<u8>, ConnectionError>,
    ) -> Result<Vec<u8>, TransportError> {
        self.tunnel.check()?;
        let mut slot = self.connection.lock().map_err(|_| TunnelError::Worker)?;
        let connection = match slot.take() {
            Some(connection) => connection,
            None => VerifiedConnection::connect_shared(
                self.tunnel.port(),
                self.descriptor.clone(),
                Duration::from_millis(2500),
            )?,
        };
        self.tunnel.check()?;
        let result = action(&connection);
        self.tunnel.check()?;
        // Never replay a failed request. A later explicit operation may establish
        // a new identity-proven connection, while retaining this tunnel generation.
        if result.is_ok() {
            *slot = Some(connection);
        }
        Ok(result?)
    }
    pub(crate) fn get_resource(&self, path: &str) -> Result<Vec<u8>, TransportError> {
        self.request(|connection| connection.get_resource(path))
    }
    pub(crate) fn post_resource(
        &self,
        path: &str,
        body: &[u8],
        headers: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<Vec<u8>, TransportError> {
        self.request(|connection| connection.post_resource(path, body, headers, timeout))
    }
}
fn check(cancelled: &AtomicBool, deadline: Instant) -> Result<(), TransportError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(TransportError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(TransportError::Timeout);
    }
    Ok(())
}
#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
