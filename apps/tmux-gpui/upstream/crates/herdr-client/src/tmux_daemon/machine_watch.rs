//! One cancellable local registry notification request. No polling registry files,
//! remote authority, mutation retries or unbounded response buffers.
use super::{Error, LocalDaemon, SavedMachineRegistry, machines::Identity};
use serde::Deserialize;
use std::{
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpStream},
    sync::{Arc, Mutex},
    time::Duration,
};
use ureq::unversioned::{
    resolver::DefaultResolver,
    transport::{Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport},
};

#[derive(Default)]
struct Cancellation {
    stopped: bool,
    socket: Option<TcpStream>,
}
/// A single watch lane. Cancellation is permanent; create a new lane to restart.
#[derive(Clone, Default)]
pub struct MachineWatchCancellation(Arc<Mutex<Cancellation>>);
impl MachineWatchCancellation {
    pub fn cancel(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.stopped = true;
            if let Some(socket) = state.socket.take() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
    pub(super) fn check(&self) -> Result<(), Error> {
        if self.0.lock().map_err(|_| Error::Retired)?.stopped {
            return Err(Error::Retired);
        }
        Ok(())
    }
    fn install(&self, socket: &TcpStream) -> Result<Lease<'_>, Error> {
        let mut state = self.0.lock().map_err(|_| Error::Retired)?;
        if state.stopped || state.socket.is_some() {
            return Err(Error::Retired);
        }
        state.socket = Some(socket.try_clone().map_err(|e| Error::Network(e.into()))?);
        Ok(Lease(self))
    }
}
struct Lease<'a>(&'a MachineWatchCancellation);
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.0.lock() {
            state.socket = None;
        }
    }
}

#[derive(Debug)]
pub struct MachineWatchUpdate {
    pub revision: String,
    /// None is an unchanged heartbeat; it must not invalidate or repaint the UI.
    pub registry: Option<SavedMachineRegistry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    daemon: Identity,
    revision: String,
    // Keep this required: a missing field is not an unchanged heartbeat.
    registry: serde_json::Value,
}
fn valid_revision(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl LocalDaemon {
    fn machine_watch_resource(
        &self,
        bytes: &[u8],
        after: Option<&str>,
    ) -> Result<MachineWatchUpdate, Error> {
        if bytes.len() > 64 * 1024 {
            return Err(Error::ResourceFormat);
        }
        let resource: Resource =
            serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
        self.machine_identity(&resource.daemon)?;
        if !valid_revision(&resource.revision) {
            return Err(Error::ResourceFormat);
        }
        let registry = if resource.registry.is_null() {
            if after != Some(resource.revision.as_str()) {
                return Err(Error::ResourceFormat);
            }
            None
        } else {
            Some(
                serde_json::from_value::<SavedMachineRegistry>(resource.registry)
                    .map_err(|_| Error::ResourceFormat)?
                    .validated()?,
            )
        };
        Ok(MachineWatchUpdate {
            revision: resource.revision,
            registry,
        })
    }
    /// Worker-only. The daemon holds unchanged requests for at most 20 seconds.
    /// Cancellation shuts down the owned socket, including during body reads.
    pub fn watch_saved_machines(
        &self,
        after: Option<&str>,
        cancellation: &MachineWatchCancellation,
    ) -> Result<MachineWatchUpdate, Error> {
        if after.is_some_and(|value| !valid_revision(value)) {
            return Err(Error::ActionInput);
        }
        cancellation.check()?;
        self.verify_current()?;
        cancellation.check()?;
        let mut endpoint = self
            .base_url
            .join("api/resources/saved-machines/watch")
            .map_err(|_| Error::Endpoint)?;
        endpoint
            .query_pairs_mut()
            .append_pair("expectedInstanceId", self.instance_id());
        if let Some(after) = after {
            endpoint.query_pairs_mut().append_pair("after", after);
        }
        // Local record validation permits only literal loopback or localhost.
        // Resolve localhost ourselves; no DNS/proxy can redirect owner authority.
        let ip = match self.base_url.host() {
            Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
            Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
            Some(url::Host::Domain("localhost")) => IpAddr::V4(Ipv4Addr::LOCALHOST),
            _ => return Err(Error::Endpoint),
        };
        let address = SocketAddr::new(ip, endpoint.port_or_known_default().ok_or(Error::Endpoint)?);
        let socket = TcpStream::connect_timeout(&address, Duration::from_millis(2500))
            .map_err(|e| Error::Network(e.into()))?;
        let _lease = cancellation.install(&socket)?;
        self.check_record()?;
        let authority = endpoint[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
        let agent = ureq::Agent::with_parts(
            ureq::Agent::config_builder()
                .proxy(None)
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(Duration::from_secs(25)))
                .build(),
            PinnedConnector {
                socket: Mutex::new(Some(socket)),
                authority,
            },
            DefaultResolver::default(),
        );
        let result = (|| {
            let mut response = agent
                .get(endpoint.as_str())
                .header("Authorization", self.record.authorization()?)
                .header("Cache-Control", "no-store")
                .call()
                .map_err(Error::Network)?;
            if response.status().as_u16() != 200 {
                return Err(Error::RequestStatus(response.status().as_u16()));
            }
            let bytes = response
                .body_mut()
                .with_config()
                .limit(64 * 1024)
                .read_to_vec()
                .map_err(Error::Network)?;
            self.check_record()?;
            self.machine_watch_resource(&bytes, after)
        })();
        cancellation.check()?;
        result
    }
}

#[derive(Debug)]
struct PinnedConnector {
    socket: Mutex<Option<TcpStream>>,
    authority: String,
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
            return Err(
                io::Error::new(io::ErrorKind::PermissionDenied, "watch authority changed").into(),
            );
        }
        let socket = self
            .socket
            .lock()
            .map_err(|_| io::Error::other("watch connector poisoned"))?
            .take()
            .ok_or_else(|| io::Error::other("watch socket cannot be replaced"))?;
        Ok(Some(SocketTransport {
            socket,
            buffers: LazyBuffers::new(4096, 4096),
        }))
    }
}
#[derive(Debug)]
struct SocketTransport {
    socket: TcpStream,
    buffers: LazyBuffers,
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

#[cfg(all(test, unix))]
#[path = "machine_watch_tests.rs"]
mod tests;
