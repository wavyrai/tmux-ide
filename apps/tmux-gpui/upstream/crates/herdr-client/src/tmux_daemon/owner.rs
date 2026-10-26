//! Catalog transport choice. Local provenance is an explicit operation and cannot
//! be synthesized from a remote URL or SSH descriptor.
use super::{Error, LocalDaemon, ServerRegistration};
use std::{sync::Arc, time::Duration};
#[derive(Clone)]
pub(super) enum Owner {
    Local(Arc<LocalDaemon>),
    #[cfg(unix)]
    Remote(Arc<crate::tmux_ssh::RemoteTransport>),
}
impl Owner {
    pub(super) fn catalog_identity(&self) -> super::CatalogIdentity {
        match self {
            Self::Local(daemon) => super::CatalogIdentity {
                instance_id: daemon.record.instance_id.clone(),
                environment_id: daemon.record.environment_id.clone(),
            },
            #[cfg(unix)]
            Self::Remote(remote) => super::CatalogIdentity {
                instance_id: remote.instance_id().into(),
                environment_id: remote.environment_id().map(str::to_owned),
            },
        }
    }

    pub(super) fn local(&self) -> Result<&LocalDaemon, Error> {
        match self {
            Self::Local(daemon) => Ok(daemon),
            #[cfg(unix)]
            Self::Remote(_) => Err(Error::LocalAuthorityRequired),
        }
    }
    pub(super) fn verify_current(&self) -> Result<(), Error> {
        self.local()?.verify_current()
    }
    pub(super) fn list_servers(&self) -> Result<Vec<ServerRegistration>, Error> {
        super::servers::parse(&self.get_resource("api/v1/tmux-servers")?)
    }
    pub(super) fn get_resource(&self, path: &str) -> Result<Vec<u8>, Error> {
        match self {
            Self::Local(daemon) => daemon.get_resource(path),
            #[cfg(unix)]
            Self::Remote(remote) => remote.get_resource(path).map_err(remote_error),
        }
    }
    pub(super) fn post_resource(&self, path: &str, body: &[u8]) -> Result<Vec<u8>, Error> {
        self.post_resource_with_headers(path, body, &[])
    }
    pub(super) fn post_resource_with_headers(
        &self,
        path: &str,
        body: &[u8],
        headers: &[(&str, &str)],
    ) -> Result<Vec<u8>, Error> {
        self.post_resource_with_options(path, body, headers, Duration::from_millis(2500))
    }
    pub(super) fn post_resource_with_options(
        &self,
        path: &str,
        body: &[u8],
        headers: &[(&str, &str)],
        timeout: Duration,
    ) -> Result<Vec<u8>, Error> {
        match self {
            Self::Local(daemon) => daemon.post_resource_with_options(path, body, headers, timeout),
            #[cfg(unix)]
            Self::Remote(remote) => remote
                .post_resource(path, body, headers, timeout)
                .map_err(remote_error),
        }
    }
}
#[cfg(unix)]
pub(super) fn remote_error(error: crate::tmux_ssh::TransportError) -> Error {
    match error {
        crate::tmux_ssh::TransportError::Connection(crate::tmux_ssh::ConnectionError::Status(
            status,
        )) => Error::RequestStatus(status),
        crate::tmux_ssh::TransportError::Cancelled => Error::Retired,
        other => Error::Remote(Box::new(other)),
    }
}

#[cfg(all(test, unix))]
#[path = "owner_remote_terminal_tests.rs"]
mod remote_terminal_tests;
#[cfg(all(test, unix))]
#[path = "owner_tests.rs"]
mod tests;
