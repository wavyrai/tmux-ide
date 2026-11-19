//! One identity proof per actual TCP connection. The agent may reuse its verified
//! socket, but its connector can never redial after the proof, even on HTTP retry.
use super::RemoteDescriptor;
use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use ureq::unversioned::{
    resolver::DefaultResolver,
    transport::{ConnectionDetails, Connector, TcpConnector},
};

#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    #[error("Invalid remote resource path")]
    Path,
    #[error("Invalid SSH forward port")]
    Port,
    #[error("Remote daemon connection failed")]
    Network(#[source] ureq::Error),
    #[error("Remote daemon identity does not match SSH discovery")]
    Identity,
    #[error("Remote daemon returned HTTP {0}")]
    Status(u16),
}

#[derive(Debug)]
struct OnceConnector {
    port: u16,
    used: AtomicBool,
    /// Set when ureq asked for a second socket and was refused. ureq asks its
    /// connector once per request, before writing anything (no retries, no
    /// redirects here), so a refused request sent nothing at all.
    refused: Arc<AtomicBool>,
}
impl Connector for OnceConnector {
    type Out = <TcpConnector as Connector>::Out;
    fn connect(
        &self,
        details: &ConnectionDetails,
        _: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        if details.uri.scheme_str() != Some("http")
            || details.uri.host() != Some("127.0.0.1")
            || details.uri.port_u16() != Some(self.port)
            || self.used.swap(true, Ordering::AcqRel)
        {
            self.refused.store(true, Ordering::Release);
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "SSH connection cannot be replaced",
            )
            .into());
        }
        TcpConnector::default().connect(details, None)
    }
}

/// Worker-only HTTP connection. Does not grant local image/editor provenance.
/// This owns no SSH child: the caller must retain the tunnel's lifetime and fence
/// its generation. Construction proves identity again for every new instance.
pub struct VerifiedConnection {
    agent: ureq::Agent,
    base: String,
    descriptor: Arc<RemoteDescriptor>,
    refused: Arc<AtomicBool>,
}
/// How long ureq keeps an idle proven socket. A daemon from attach-rtt on
/// keeps an owner connection 65 s; an older one closes it after 5 s, which
/// ureq notices before reuse, and the transport then proves a new one.
const IDLE_SOCKET: Duration = Duration::from_secs(60);
impl VerifiedConnection {
    pub fn connect(port: u16, descriptor: RemoteDescriptor) -> Result<Self, ConnectionError> {
        Self::connect_shared(port, Arc::new(descriptor), Duration::from_millis(2500))
    }
    pub(super) fn connect_shared(
        port: u16,
        descriptor: Arc<RemoteDescriptor>,
        timeout: Duration,
    ) -> Result<Self, ConnectionError> {
        if port == 0 {
            return Err(ConnectionError::Port);
        }
        if timeout.is_zero() {
            return Err(ConnectionError::Network(
                io::Error::new(io::ErrorKind::TimedOut, "SSH identity deadline expired").into(),
            ));
        }
        let config = ureq::Agent::config_builder()
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(timeout))
            .max_idle_age(IDLE_SOCKET)
            .build();
        let refused = Arc::new(AtomicBool::new(false));
        let agent = ureq::Agent::with_parts(
            config,
            OnceConnector {
                port,
                used: AtomicBool::new(false),
                refused: refused.clone(),
            },
            DefaultResolver::default(),
        );
        let base = format!("http://127.0.0.1:{port}");
        let mut response = agent
            .get(format!("{base}/identity"))
            .call()
            .map_err(ConnectionError::Network)?;
        if response.status().as_u16() != 200 {
            return Err(ConnectionError::Identity);
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(64 * 1024)
            .read_to_vec()
            .map_err(ConnectionError::Network)?;
        if !descriptor.matches_identity(&bytes) {
            return Err(ConnectionError::Identity);
        }
        Ok(Self {
            agent,
            base,
            descriptor,
            refused,
        })
    }
    /// Whether this connection's socket closed while idle, so that a request
    /// failed before sending anything: it is safe to send it once more on a
    /// new identity-proven connection.
    pub(crate) fn closed_before_send(&self) -> bool {
        self.refused.load(Ordering::Acquire)
    }
    /// Fixed endpoint prevents untrusted remote catalog data selecting a new host.
    pub fn capabilities(&self) -> Result<Vec<u8>, ConnectionError> {
        self.get_resource("api/v2/capabilities")
    }
    fn endpoint(&self, path: &str) -> Result<String, ConnectionError> {
        if !path.starts_with("api/")
            || path.contains('#')
            || path.contains('\\')
            || path.bytes().any(|b| b <= b' ' || b == 127)
        {
            return Err(ConnectionError::Path);
        }
        Ok(format!("{}/{path}", self.base))
    }
    /// `get_resource` with its own bound, for a caller with a deadline.
    pub(crate) fn get_resource_within(
        &self,
        path: &str,
        timeout: Duration,
    ) -> Result<Vec<u8>, ConnectionError> {
        if timeout.is_zero() {
            return Err(ConnectionError::Network(
                io::Error::new(io::ErrorKind::TimedOut, "SSH request deadline expired").into(),
            ));
        }
        let response = self
            .agent
            .get(self.endpoint(path)?)
            .header("Authorization", self.descriptor.authorization())
            .header("Cache-Control", "no-store")
            .config()
            .timeout_global(Some(timeout))
            .build()
            .call()
            .map_err(ConnectionError::Network)?;
        read_response(response)
    }
    pub(crate) fn get_resource(&self, path: &str) -> Result<Vec<u8>, ConnectionError> {
        let response = self
            .agent
            .get(self.endpoint(path)?)
            .header("Authorization", self.descriptor.authorization())
            .header("Cache-Control", "no-store")
            .call()
            .map_err(ConnectionError::Network)?;
        read_response(response)
    }
    pub(crate) fn post_resource(
        &self,
        path: &str,
        body: &[u8],
        headers: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<Vec<u8>, ConnectionError> {
        let mut request = self
            .agent
            .post(self.endpoint(path)?)
            .header("Authorization", self.descriptor.authorization())
            .header("Content-Type", "application/json");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request
            .config()
            .timeout_global(Some(timeout))
            .build()
            .send(body)
            .map_err(ConnectionError::Network)?;
        read_response(response)
    }
}
fn read_response(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<Vec<u8>, ConnectionError> {
    if response.status().as_u16() != 200 {
        return Err(ConnectionError::Status(response.status().as_u16()));
    }
    response
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_to_vec()
        .map_err(ConnectionError::Network)
}
#[cfg(test)]
#[path = "connection_tests.rs"]
mod tests;
