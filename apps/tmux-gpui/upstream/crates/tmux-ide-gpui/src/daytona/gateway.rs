//! The `ssh` command that reaches a sandbox through Daytona's SSH gateway.
//! Daytona issues a short-lived token per sandbox and an `ssh` command that
//! uses it as the user name; that command is parsed, never run as text.
//!
//! The token never appears in argv, which other local users can read: it
//! goes in a private, temporary `ssh` config file that also replaces the
//! user's own config, so no alias, proxy, or forward of theirs applies. The
//! file lives until the caller drops the [`Gateway`]; `ssh` reads it at start.
//!
//! Daytona publishes no host key for its gateway, so the first key seen is
//! pinned in a GUI-owned `known_hosts` file and later changes are refused.

use super::{Error, Result, api::SshAccess};
use secrecy::{ExposeSecret, SecretString};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

/// The host alias the temporary config defines.
const ALIAS: &str = "herdr-daytona-gateway";

/// Where Daytona's `ssh` command says to connect.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Endpoint {
    pub(crate) host: String,
    pub(crate) port: u16,
}

fn host_name(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with(['-', '.'])
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
}

/// Tokens become the `User` of an `ssh` config; nothing that could end the
/// line or start another keyword is accepted.
fn plain_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 512
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Read `ssh [-p PORT] TOKEN@HOST`. Anything else, including a user other
/// than the issued token, is refused rather than guessed at.
pub(crate) fn endpoint(command: &str, token: &str) -> Result<Endpoint> {
    let mut words = command.split_whitespace();
    if words.next() != Some("ssh") {
        return Err(Error::Gateway);
    }
    let mut port = 22;
    let mut destination = None;
    while let Some(word) = words.next() {
        match word {
            "-p" => {
                port = words
                    .next()
                    .and_then(|port| port.parse().ok())
                    .ok_or(Error::Gateway)?;
            }
            _ if word.starts_with('-') || destination.is_some() => return Err(Error::Gateway),
            _ => destination = Some(word),
        }
    }
    let (user, host) = destination
        .and_then(|destination| destination.split_once('@'))
        .ok_or(Error::Gateway)?;
    if user != token || !plain_token(token) || !host_name(host) || port == 0 {
        return Err(Error::Gateway);
    }
    Ok(Endpoint {
        host: host.to_owned(),
        port,
    })
}

fn config_text(endpoint: &Endpoint, token: &SecretString, known_hosts: &Path) -> Result<String> {
    let known_hosts = known_hosts.to_str().ok_or(Error::Gateway)?;
    if known_hosts.contains(['"', '\n', '\r']) {
        return Err(Error::Gateway);
    }
    Ok(format!(
        "Host {ALIAS}\n\
         \tHostName {host}\n\
         \tPort {port}\n\
         \tUser {user}\n\
         \tBatchMode yes\n\
         \tNumberOfPasswordPrompts 0\n\
         \tStrictHostKeyChecking accept-new\n\
         \tUserKnownHostsFile \"{known_hosts}\"\n\
         \tGlobalKnownHostsFile /dev/null\n\
         \tConnectTimeout 15\n\
         \tConnectionAttempts 1\n\
         \tServerAliveInterval 15\n\
         \tServerAliveCountMax 4\n\
         \tForwardAgent no\n\
         \tForwardX11 no\n\
         \tClearAllForwardings yes\n\
         \tControlMaster no\n\
         \tLogLevel ERROR\n",
        host = endpoint.host,
        port = endpoint.port,
        user = token.expose_secret(),
    ))
}

/// An `ssh` command for one sandbox, with the config file it reads. Append
/// the remote command, run it, and drop this only once `ssh` has started.
pub(crate) struct Gateway {
    pub(crate) command: Command,
    _config: tempfile::NamedTempFile,
}

impl Gateway {
    pub(crate) fn new(access: &SshAccess, known_hosts: &Path) -> Result<Self> {
        let endpoint = endpoint(
            access.ssh_command.expose_secret(),
            access.token.expose_secret(),
        )?;
        if let Some(parent) = known_hosts.parent() {
            std::fs::create_dir_all(parent).map_err(Error::GatewayFile)?;
        }
        // Created 0600 in the temporary directory; removed on drop.
        let mut config = tempfile::NamedTempFile::new().map_err(Error::GatewayFile)?;
        config
            .write_all(config_text(&endpoint, &access.token, known_hosts)?.as_bytes())
            .and_then(|()| config.flush())
            .map_err(Error::GatewayFile)?;
        let mut command = Command::new("ssh");
        command
            .arg("-F")
            .arg(config.path())
            .args(["-T", "--", ALIAS]);
        Ok(Self {
            command,
            _config: config,
        })
    }
}

/// Fail before anything is created when `ssh` cannot run: a sandbox made for
/// a device that can never connect keeps running, and may be billed.
pub(crate) fn check_ssh() -> Result<()> {
    Command::new("ssh")
        .arg("-V")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(drop)
        .map_err(Error::SshMissing)
}

/// The GUI's own record of the gateway's host key.
pub(crate) fn known_hosts() -> Result<std::path::PathBuf> {
    crate::preferences::state_dir()
        .map(|dir| dir.join("daytona_known_hosts"))
        .ok_or(Error::Cloud(crate::cloud::Error::StateDirectory))
}

#[cfg(test)]
mod tests;
