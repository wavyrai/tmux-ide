//! Online peers on the user's tailnet, read from `tailscale status --json`.
//! Only the local Tailscale client is asked; peers are never contacted.

use super::{Candidate, Source, valid_host};
use crate::{Error, Result, menu::devices::setup};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    net::IpAddr,
    path::{Path, PathBuf},
    time::Duration,
};

/// The status call is local IPC to `tailscaled`.
const TIMEOUT: Duration = Duration::from_secs(5);
/// A large tailnet's status stays well under this.
const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024;
const MAX_PEERS: usize = 64;

/// Where the CLI lives when a GUI app's `PATH` does not reach it: Homebrew on
/// Apple silicon and Intel, the Mac app bundle, and Linux packages.
const LOCATIONS: [&str; 4] = [
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
];

/// Operating systems that can run an SSH server Herdr reaches. Phones, TVs,
/// and Windows peers are left out.
const SSH_SYSTEMS: [&str; 8] = [
    "linux",
    "macos",
    "freebsd",
    "openbsd",
    "netbsd",
    "dragonfly",
    "illumos",
    "solaris",
];

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Status {
    #[serde(default)]
    peer: Option<BTreeMap<String, Peer>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Peer {
    #[serde(default, rename = "DNSName")]
    dns_name: String,
    #[serde(default)]
    host_name: String,
    #[serde(default, rename = "OS")]
    os: String,
    #[serde(default)]
    online: bool,
    #[serde(default, rename = "TailscaleIPs")]
    addresses: Vec<IpAddr>,
}

/// The tailnet's online peers, or none when Tailscale is not installed.
/// Blocks on a process: call it from the background executor.
pub(super) fn peers() -> Result<Vec<Candidate>> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let Some(executable) = executable(&path, |path| path.is_file()) else {
        return Ok(Vec::new());
    };
    let (status, stdout, stderr) = match setup::run_bounded(
        executable.as_os_str(),
        &["status", "--json"],
        TIMEOUT,
        OUTPUT_LIMIT,
    ) {
        Err(Error::DeviceSetupTimeout) => return Err(Error::TailscaleTimeout),
        result => result?,
    };
    if !status.success() {
        return Err(Error::TailscaleStatus {
            status,
            detail: setup::last_line(&stderr),
        });
    }
    parse(&stdout)
}

/// The first `tailscale` on `PATH`, then the usual install locations.
pub(super) fn executable(path: &OsStr, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|directory| directory.join("tailscale"))
        .chain(LOCATIONS.into_iter().map(PathBuf::from))
        .find(|candidate| candidate.is_absolute() && exists(candidate))
}

/// Suggestions from a status document: each online peer on a system that can
/// serve SSH, by its MagicDNS name. This machine is not a peer.
pub(super) fn parse(json: &[u8]) -> Result<Vec<Candidate>> {
    let status: Status = serde_json::from_slice(json).map_err(Error::TailscaleJson)?;
    let mut peers: Vec<Candidate> = status
        .peer
        .unwrap_or_default()
        .into_values()
        .filter(|peer| {
            peer.online
                && SSH_SYSTEMS
                    .iter()
                    .any(|system| system.eq_ignore_ascii_case(&peer.os))
        })
        .filter_map(candidate)
        .collect();
    peers.sort_by(|a, b| a.name.cmp(&b.name));
    peers.truncate(MAX_PEERS);
    Ok(peers)
}

fn candidate(peer: Peer) -> Option<Candidate> {
    let dns = peer.dns_name.trim_end_matches('.');
    let addresses: Vec<String> = peer.addresses.iter().map(IpAddr::to_string).collect();
    let target = if valid_host(dns) {
        dns.to_owned()
    } else {
        addresses.first()?.clone()
    };
    // The MagicDNS label is unique in the tailnet; the OS host name is often
    // `localhost` or a sentence.
    let name = dns
        .split('.')
        .next()
        .filter(|label| valid_host(label))
        .unwrap_or(&peer.host_name);
    let hosts: Vec<&str> = std::iter::once(target.as_str())
        .chain(addresses.iter().map(String::as_str))
        .collect();
    Some(Candidate::new(
        Source::Tailscale,
        name,
        target.clone(),
        &hosts,
    ))
}
