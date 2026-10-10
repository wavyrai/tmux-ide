//! Reaching a saved Coder workspace: make sure it is running, then run
//! Herdr's stdio bridge through `coder ssh`. Coder's tunnel authenticates the
//! connection, so there is no SSH config edit or host-key trust decision here.
//! Runs on the connection worker; every wait observes `stop`.

use super::{Error, Result, Settings, api, store};
use herdr_client::Transport;
use secrecy::{ExposeSecret, SecretString};
use std::{
    io,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};

/// Places a `coder` binary is commonly installed. A GUI launched from the
/// Finder does not inherit a login shell's PATH, so PATH alone is not enough.
const SEARCH: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// The `coder` executable: the configured path, else PATH, else the usual
/// roots. A configured path that cannot run is an error here, before anything
/// is created, rather than after a workspace that may be billed is built.
pub(crate) fn cli(settings: &Settings) -> Result<PathBuf> {
    if let Some(path) = &settings.cli {
        return executable(path).then(|| path.clone()).ok_or(Error::Cli);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .chain(SEARCH.iter().map(PathBuf::from))
        .chain(
            home.iter()
                .flat_map(|home| [home.join(".local/bin"), home.join("bin")]),
        )
        .map(|dir| dir.join("coder"))
        .find(|candidate| executable(candidate))
        .ok_or(Error::Cli)
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(path: &Path) -> bool {
    path.is_file()
}

/// `coder ssh` for one workspace agent, authenticated only through this
/// child's environment. The remote command is appended by the caller.
pub(crate) fn ssh_command(
    cli: &Path,
    settings: &Settings,
    token: &SecretString,
    workspace: &str,
    agent: &str,
) -> Result<Command> {
    if !super::names::existing(workspace)
        || agent.is_empty()
        || agent.len() > 64
        || !agent
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Error::Field("Coder workspace"));
    }
    let mut command = Command::new(cli);
    command
        .env("CODER_URL", &settings.base)
        .env("CODER_SESSION_TOKEN", token.expose_secret())
        // Readiness was checked through the API; do not block on startup logs.
        .args(["ssh", "--wait=no", "--", &format!("{workspace}.{agent}")]);
    Ok(command)
}

/// The saved workspace is reached by its ID, and `coder ssh` gets its current
/// name: a renamed workspace still connects, and one deleted and replaced
/// under the same name is reported deleted instead of opening the newcomer.
fn connect_workspace(
    settings: &Settings,
    id: &str,
    session: &str,
    stop: &AtomicBool,
) -> Result<herdr_client::Bridge> {
    let tokens = |rejected| store::current_token(settings, rejected);
    let cancelled = || stop.load(Ordering::Acquire);
    let (workspace, agent) = api::wait_ready(settings, &tokens, id, cancelled, |progress| {
        tracing::info!(
            category = "coder_connect",
            ?progress,
            "Waiting for Coder workspace"
        );
    })?;
    let command = ssh_command(
        &cli(settings)?,
        settings,
        &tokens(false)?,
        &workspace.name,
        &agent,
    )?;
    herdr_client::connect_command(command, session, stop).map_err(Error::Bridge)
}

/// Reach the Coder workspace with `id` on `deployment` for `cloud::connect`.
/// Configuration is read here, on the worker, so a deployment changed in the
/// config file applies on retry.
pub(crate) fn connect(
    deployment: &str,
    id: &str,
    session: &str,
    stop: &AtomicBool,
) -> io::Result<Transport> {
    let result = crate::config::Config::load()
        .map_err(|error| Error::Storage(Box::new(error)))
        .and_then(|config| {
            config
                .coder
                .settings()
                .map_err(|error| Error::Storage(Box::new(error)))
        })
        .and_then(|settings| {
            let settings = settings.ok_or(Error::Missing("url"))?;
            if settings.base != deployment {
                return Err(Error::Deployment);
            }
            connect_workspace(&settings, id, session, stop)
        });
    match result {
        Ok(bridge) => Ok(bridge.into()),
        Err(Error::Bridge(error)) => Err(io::Error::new(error.kind(), error)),
        Err(error) => Err(io::Error::other(error)),
    }
}

#[cfg(test)]
mod tests;
