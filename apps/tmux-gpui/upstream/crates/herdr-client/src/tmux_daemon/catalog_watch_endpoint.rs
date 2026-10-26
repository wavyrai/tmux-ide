//! Private credential-bearing endpoint. Never publish or format this value.
use super::{CatalogEventIdentity, Error, owner::Owner};
use crate::tmux_ssh::PeerIdentity;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
pub(crate) struct CatalogWatchEndpoint {
    pub(crate) address: SocketAddr,
    pub(crate) peer: PeerIdentity,
    pub(crate) identity: CatalogEventIdentity,
    pub(crate) authorization: tungstenite::http::HeaderValue,
}
impl Owner {
    pub(super) fn catalog_watch_endpoint(&self) -> Result<CatalogWatchEndpoint, Error> {
        match self {
            Self::Local(daemon) => {
                daemon.verify_current()?;
                let r = &daemon.record;
                let identity = CatalogEventIdentity {
                    protocol_version: r.protocol_version,
                    product_version: r.product_version.clone(),
                    instance_id: r.instance_id.clone(),
                    started_at: r.started_at.clone(),
                    environment_id: r.environment_id.clone(),
                };
                let mut value = serde_json::json!({"pid":r.pid,"protocolVersion":r.protocol_version,
                    "productVersion":r.product_version,"instanceId":r.instance_id,"startedAt":r.started_at});
                if let Some(environment) = &r.environment_id {
                    value["environmentId"] = environment.clone().into();
                }
                let peer = serde_json::from_value(value).map_err(|_| Error::IdentityFormat)?;
                let ip = match daemon.base_url.host() {
                    Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
                    Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
                    Some(url::Host::Domain("localhost")) => IpAddr::V4(Ipv4Addr::LOCALHOST),
                    _ => return Err(Error::Endpoint),
                };
                Ok(CatalogWatchEndpoint {
                    address: SocketAddr::new(ip, daemon.base_url.port().ok_or(Error::Endpoint)?),
                    peer,
                    identity,
                    authorization: r.authorization()?,
                })
            }
            #[cfg(unix)]
            Self::Remote(remote) => remote
                .catalog_watch_endpoint()
                .map_err(super::owner::remote_error),
        }
    }
    pub(super) fn check_watch_owner(&self) -> Result<(), Error> {
        match self {
            Self::Local(daemon) => daemon.check_record(),
            #[cfg(unix)]
            Self::Remote(remote) => remote
                .capability_route()
                .map(|_| ())
                .map_err(super::owner::remote_error),
        }
    }
}
