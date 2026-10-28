//! TCP ports each workspace's processes listen on, for the sidebar and the
//! status bar, where clicking one opens it in a browser tab.
//!
//! Every host has its own worker thread scanning it every few seconds through
//! one long-lived `sh`: a local one for this machine, the host's own over SSH
//! for a remote one. The UI thread only starts and stops workers and takes
//! their answers on later ticks, so a slow `lsof` or an unreachable host never
//! blocks rendering or delays another host.

mod render;
mod scan;
mod tunnel;

#[cfg(test)]
mod tests;

use crate::{
    Error, Result,
    system_load::Stop,
    usage::{Host, Shell},
};
use herdr_client::ConnectTarget;
pub(crate) use render::chips;
pub(crate) use scan::{Link, Origin, Port, Ports, parse};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};
pub(crate) use tunnel::Tunnels;

/// Ports open and close at human pace; `lsof` is not free on a busy machine.
const INTERVAL: Duration = Duration::from_secs(5);
/// A host that could not be scanned is tried again after this long.
const RETRY: Duration = Duration::from_secs(30);
const STEP_TIMEOUT: Duration = Duration::from_secs(15);
/// Hosts are few; an unbounded endpoint list still cannot start more workers.
const HOST_LIMIT: usize = 16;

/// The daemon an endpoint shows. A port is listed under one of its
/// workspaces only when the port's pane belongs to this daemon, so two
/// sessions on one machine never claim each other's servers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Daemon {
    host: Host,
    identity: Option<Identity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Identity {
    /// This machine's daemon, by the client socket the endpoint dials.
    Client(PathBuf),
    /// A remote daemon, by its session name; its paths are the remote's own.
    Session(String),
}

impl Daemon {
    /// The daemon behind `target`, or `None` for a cloud machine, whose ports
    /// cannot be scanned without its provider's command.
    pub(crate) fn of(target: &ConnectTarget) -> Option<Self> {
        let host = Host::of(target)?;
        let identity = match target.remote_session() {
            Some(session) => Some(Identity::Session(session.to_owned())),
            None => target.socket_path().ok().map(Identity::Client),
        };
        Some(Self { host, identity })
    }

    #[cfg(test)]
    pub(crate) fn host(&self) -> &Host {
        &self.host
    }

    /// Whether a pane whose `HERDR_SOCKET_PATH` was `socket` is this daemon's.
    /// A pane that did not say, from an older Herdr, is given the benefit of
    /// the doubt, as is a daemon whose socket cannot be named.
    fn owns(&self, socket: &str) -> bool {
        let (false, Some(identity)) = (socket.is_empty(), &self.identity) else {
            return true;
        };
        let api = Path::new(socket);
        match identity {
            Identity::Client(client) => client_socket(api).as_deref() == Some(client.as_path()),
            Identity::Session(name) => session_name(api) == Some(name.as_str()),
        }
    }
}

/// The client socket a daemon serves beside its API socket, `herdr.sock`
/// beside `herdr-client.sock`, as herdr-client's discovery derives it.
fn client_socket(api: &Path) -> Option<PathBuf> {
    let stem = api.file_stem()?.to_str()?;
    Some(api.parent()?.join(format!("{stem}-client.sock")))
}

/// `…/sessions/<name>/herdr.sock` belongs to session `name`; the socket in
/// the configuration root belongs to `default`.
fn session_name(api: &Path) -> Option<&str> {
    let directory = api.parent()?;
    if directory.parent()?.file_name()? == "sessions" {
        directory.file_name()?.to_str()
    } else {
        Some("default")
    }
}

/// The shell a host is scanned through.
fn open(host: &Host) -> Result<Shell> {
    match host {
        Host::Local => local_shell(),
        Host::Ssh(target) => Shell::connect(target),
        Host::Wsl(_) => Err(Error::WslHostUnsupported),
    }
    .map_err(failed)
}

#[cfg(unix)]
fn local_shell() -> Result<Shell> {
    let mut command = std::process::Command::new("/bin/sh");
    command
        .arg("-s")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    Shell::start(command)
}

/// Windows has neither `ss` nor `lsof`, and its own tools are not wired up.
#[cfg(windows)]
fn local_shell() -> Result<Shell> {
    Err(Error::ListeningPortsUnsupported)
}

/// Where a browser finds `host`. Resolving an SSH alias reads configuration
/// only, but runs `ssh -G`, so it happens on the worker, once per worker.
fn origin(host: &Host) -> Origin {
    let resolved = match host {
        Host::Local | Host::Wsl(_) => None,
        Host::Ssh(target) => herdr_client::resolve_destination(target)
            .inspect_err(|error| {
                tracing::debug!(category = "listening-ports", %error, "could not resolve an SSH host name");
            })
            .ok()
            .map(|destination| destination.host),
    };
    Origin::new(host, resolved.as_deref())
}

/// One scan of a host, with where its ports open.
#[derive(Debug, PartialEq)]
struct Scan {
    ports: Ports,
    origin: Origin,
}

fn scan(shell: &mut Shell) -> Result<Ports> {
    let output = shell.run(scan::COMMAND, STEP_TIMEOUT).map_err(failed)?;
    parse(&output.stdout)
}

fn failed(error: Error) -> Error {
    Error::ListeningPorts(Box::new(error))
}

struct Worker {
    stop: Arc<Stop>,
    results: mpsc::Receiver<Result<Scan>>,
}

impl Drop for Worker {
    /// The thread ends after its current scan; nothing waits for it here.
    fn drop(&mut self) {
        self.stop.stop();
    }
}

fn spawn(host: Host) -> Option<Worker> {
    let stop = Arc::new(Stop::default());
    let (sender, results) = mpsc::sync_channel(2);
    let shared = stop.clone();
    let spawned = thread::Builder::new()
        .name("herdr-listening-ports".into())
        .spawn(move || run(&host, &shared, &sender));
    match spawned {
        Ok(_) => Some(Worker { stop, results }),
        Err(error) => {
            tracing::warn!(category = "listening-ports", %error, "could not start a port scanner");
            None
        }
    }
}

fn run(host: &Host, stop: &Stop, results: &mpsc::SyncSender<Result<Scan>>) {
    let origin = origin(host);
    let mut shell: Option<Shell> = None;
    loop {
        let opened = match shell.take() {
            Some(shell) => Ok(shell),
            None => open(host),
        };
        let result = opened.and_then(|mut opened| {
            let ports = scan(&mut opened);
            // A failed step leaves the shell unusable; a missing tool does not.
            if !matches!(ports, Err(Error::ListeningPorts(_))) {
                shell = Some(opened);
            }
            ports.map(|ports| Scan {
                ports,
                origin: origin.clone(),
            })
        });
        let due = Instant::now() + if result.is_ok() { INTERVAL } else { RETRY };
        match results.try_send(result) {
            // The UI is behind; it will take the next one.
            Ok(()) | Err(mpsc::TrySendError::Full(_)) => {}
            Err(mpsc::TrySendError::Disconnected(_)) => return,
        }
        if !stop.wait(due) {
            return;
        }
    }
}

/// One host's latest scan.
#[derive(Default)]
struct Reading {
    ports: Ports,
    origin: Origin,
    /// Why the latest scan failed, as last logged; the last good ports stay
    /// shown.
    error: Option<String>,
}

impl Reading {
    /// Whether anything shown changed.
    fn apply(&mut self, result: Result<Scan>) -> bool {
        match result {
            Ok(Scan { ports, origin }) => {
                self.error = None;
                if ports == self.ports && origin == self.origin {
                    return false;
                }
                self.ports = ports;
                self.origin = origin;
                true
            }
            Err(error) => {
                // The display boundary: the cause says what went wrong.
                let mut text = error.to_string();
                let mut source = std::error::Error::source(&error);
                while let Some(cause) = source {
                    text.push(' ');
                    text.push_str(&cause.to_string());
                    source = cause.source();
                }
                // Nothing shown changes; the reason is logged once, not every retry.
                if self.error.as_deref() != Some(text.as_str()) {
                    tracing::warn!(category = "listening-ports", error = %text, "could not scan listening ports");
                    self.error = Some(text);
                }
                false
            }
        }
    }
}

#[derive(Default)]
struct Monitor {
    /// None once its thread could not start or has ended.
    worker: Option<Worker>,
    reading: Reading,
}

/// One workspace's ports and where a browser finds them.
#[derive(Clone, Copy)]
pub(crate) struct Listed<'a> {
    pub ports: &'a [Port],
    pub origin: &'a Origin,
}

/// Every scanned host's listening ports, keyed by host.
#[derive(Default)]
pub(crate) struct ListeningPorts {
    monitors: HashMap<Host, Monitor>,
}

impl ListeningPorts {
    /// The ports `workspace` of `daemon` listens on, lowest first, and where
    /// they open; None while it listens on none.
    pub fn get(&self, daemon: &Daemon, workspace: &str) -> Option<Listed<'_>> {
        let reading = &self.monitors.get(&daemon.host)?.reading;
        reading.ports.iter().find_map(|(owner, ports)| {
            (owner.workspace == workspace && daemon.owns(&owner.socket) && !ports.is_empty())
                .then_some(Listed {
                    ports,
                    origin: &reading.origin,
                })
        })
    }

    /// Whether any workspace on `host` still listens on `port`.
    pub fn listening(&self, host: &Host, port: u16) -> bool {
        self.monitors.get(host).is_some_and(|monitor| {
            monitor
                .reading
                .ports
                .values()
                .flatten()
                .any(|listed| listed.number == port)
        })
    }

    /// Shows `ports` for `host` as if a scan had found them, with no worker.
    #[cfg(test)]
    pub(crate) fn seed(&mut self, host: Host, ports: Ports) {
        let reading = Reading {
            origin: Origin::new(&host, None),
            ports,
            error: None,
        };
        self.monitors.insert(
            host,
            Monitor {
                worker: None,
                reading,
            },
        );
    }

    /// Scans exactly `hosts` (at most [`HOST_LIMIT`]): starts workers for new
    /// ones, stops and forgets the rest, and takes finished scans. Returns
    /// whether anything shown changed.
    pub fn poll(&mut self, hosts: impl IntoIterator<Item = Host>) -> bool {
        let mut wanted: Vec<Host> = Vec::new();
        for host in hosts {
            if wanted.len() == HOST_LIMIT {
                break;
            }
            // Several sessions on one machine share its scan.
            if !wanted.contains(&host) {
                wanted.push(host);
            }
        }
        let mut changed = false;
        self.monitors.retain(|host, monitor| {
            let keep = wanted.contains(host);
            changed |= !keep && !monitor.reading.ports.is_empty();
            keep
        });
        for host in wanted {
            self.monitors
                .entry(host)
                .or_insert_with_key(|host| Monitor {
                    worker: spawn(host.clone()),
                    reading: Reading::default(),
                });
        }
        for monitor in self.monitors.values_mut() {
            while let Some(worker) = &monitor.worker {
                match worker.results.try_recv() {
                    Ok(result) => changed |= monitor.reading.apply(result),
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => monitor.worker = None,
                }
            }
        }
        changed
    }
}
