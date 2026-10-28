//! SSH servers that announce `_ssh._tcp` over multicast DNS: a Mac with Remote
//! Login on, or a Linux host whose Avahi publishes its SSH service. Hosts that
//! do not announce themselves are not found; nothing is scanned.

use super::{Candidate, Source, valid_host};
use crate::{Error, Result};
use mdns_sd::ServiceDaemon;
use std::{
    collections::HashSet,
    net::IpAddr,
    time::{Duration, Instant},
};

const SERVICE: &str = "_ssh._tcp.local.";

/// Listen for `duration`, reporting each resolved announcement that is not
/// this machine until `found` returns `false`. Blocks: call it from the
/// background executor.
pub(super) fn browse(duration: Duration, mut found: impl FnMut(Candidate) -> bool) -> Result<()> {
    let local: HashSet<IpAddr> = if_addrs::get_if_addrs()
        .map_err(Error::LocalAddresses)?
        .into_iter()
        .map(|interface| interface.ip())
        .collect();
    let daemon = ServiceDaemon::new()?;
    let events = daemon.browse(SERVICE)?;
    let deadline = Instant::now() + duration;
    // Times out, or the daemon stopped on its own.
    while let Ok(event) = events.recv_deadline(deadline) {
        let mdns_sd::ServiceEvent::ServiceResolved(service) = event else {
            continue;
        };
        let addresses: Vec<IpAddr> = service
            .get_addresses()
            .iter()
            .map(|address| address.to_ip_addr())
            .collect();
        let Some(candidate) = candidate(
            service.get_fullname(),
            service.get_hostname(),
            service.get_port(),
            &addresses,
            &local,
        ) else {
            continue;
        };
        if !found(candidate) {
            break;
        }
    }
    // What was found stands even if the daemon's thread fails to stop
    // cleanly; it exits with this process either way.
    let _ = daemon.shutdown();
    Ok(())
}

/// The suggestion for one announcement, or `None` for this machine or a host
/// name unsafe to use as an SSH target.
pub(super) fn candidate(
    fullname: &str,
    hostname: &str,
    port: u16,
    addresses: &[IpAddr],
    local: &HashSet<IpAddr>,
) -> Option<Candidate> {
    if addresses.iter().any(|address| local.contains(address)) {
        return None;
    }
    let host = hostname.trim_end_matches('.');
    if !valid_host(host) || port == 0 {
        return None;
    }
    let instance = fullname
        .strip_suffix(SERVICE)
        .unwrap_or(fullname)
        .trim_end_matches('.');
    let name = if instance.is_empty() { host } else { instance };
    let target = if port == 22 {
        host.to_owned()
    } else {
        format!("ssh://{host}:{port}")
    };
    let addresses: Vec<String> = addresses.iter().map(IpAddr::to_string).collect();
    let hosts: Vec<&str> = std::iter::once(host)
        .chain(addresses.iter().map(String::as_str))
        .collect();
    Some(Candidate::new(Source::Bonjour, name, target, &hosts))
}
