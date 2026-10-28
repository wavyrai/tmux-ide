//! The step a host's shell runs to list TCP listeners, and the text it prints.
//!
//! Herdr exports `HERDR_WORKSPACE_ID` into every pane it starts, and a server
//! launched from a pane inherits it, so a listener's own environment names
//! its workspace exactly; no process tree or working directory is guessed.
//! Listeners whose process lacks the variable (system services, containers,
//! anything started outside Herdr) belong to no workspace and are dropped.

use super::tunnel::Key;
use crate::{Error, Result, browser::WebUrl, usage::Host};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv6Addr},
};

/// Listener lines read from one answer; the rest are ignored.
const MAX_LISTENERS: usize = 1024;
/// Ports kept per workspace, lowest first.
pub(crate) const MAX_PORTS: usize = 32;
/// Process names are display text only.
const MAX_PROCESS: usize = 32;
/// Workspace ids are short daemon tokens such as `w7V`.
const MAX_WORKSPACE_ID: usize = 64;
/// Longer socket paths than any Unix socket can have are not trusted.
const MAX_SOCKET: usize = 1024;

/// Prints `L <pid> <address:port> <process>` per listening socket, then
/// `E <pid> <workspace> <api socket>` for each listener started inside a
/// Herdr pane, the socket naming which daemon's pane that was, or
/// `N` when the host has neither `ss` nor `lsof`. Linux prefers `ss`, which
/// is quicker; macOS has only `lsof`. Both list only this user's processes
/// with their owners, so another user's servers never show. The step runs in
/// a long-lived shell, so it must not `exit`.
pub(crate) const COMMAND: &str = r#"PATH="$PATH:/usr/sbin:/sbin"
if command -v ss >/dev/null 2>&1; then
    herdr_ports=$(ss -ltnp 2>/dev/null | awk '{
        rest = $0
        while (match(rest, /\("[^"]*",pid=[0-9]+/)) {
            entry = substr(rest, RSTART + 2, RLENGTH - 2)
            rest = substr(rest, RSTART + RLENGTH)
            split(entry, part, "\",pid=")
            print "L", part[2], $4, part[1]
        }
    }')
elif command -v lsof >/dev/null 2>&1; then
    herdr_ports=$(lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null | awk '
        /^p/ { pid = substr($0, 2) }
        /^c/ { name = substr($0, 2) }
        /^n/ { print "L", pid, substr($0, 2), name }')
else
    herdr_ports=N
fi
printf '%s\n' "$herdr_ports"
for herdr_pid in $(printf '%s\n' "$herdr_ports" | awk '$1 == "L" { print $2 }' | sort -un | head -n 128); do
    if [ -r "/proc/$herdr_pid/environ" ]; then
        herdr_env=$(tr '\0' '\n' < "/proc/$herdr_pid/environ")
    else
        herdr_env=$(ps -E -ww -o command= -p "$herdr_pid" 2>/dev/null | tr ' ' '\n')
    fi
    herdr_workspace=$(printf '%s\n' "$herdr_env" | sed -n 's/^HERDR_WORKSPACE_ID=//p' | head -n 1)
    herdr_socket=$(printf '%s\n' "$herdr_env" | sed -n 's/^HERDR_SOCKET_PATH=//p' | head -n 1)
    if [ -n "$herdr_workspace" ]; then
        printf 'E %s %s %s\n' "$herdr_pid" "$herdr_workspace" "$herdr_socket"
    fi
done
true"#;

/// The address a socket listens on, which decides how it can be reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Bind {
    /// One specific, non-loopback address.
    Address(IpAddr),
    /// The host's own loopback only.
    Loopback,
    /// Every address, `*`, `0.0.0.0`, or `::`.
    Any,
}

impl Bind {
    fn parse(host: &str) -> Option<Self> {
        let host = host.trim_start_matches('[').trim_end_matches(']');
        // `ss` names the interface of a link-scoped address: `fe80::1%eth0`.
        let host = host.split('%').next().unwrap_or(host);
        if host == "*" {
            return Some(Self::Any);
        }
        let address: IpAddr = host.parse().ok()?;
        Some(if address.is_unspecified() {
            Self::Any
        } else if address.is_loopback() {
            Self::Loopback
        } else {
            Self::Address(address)
        })
    }

    /// Which of two sockets on one port to keep: the one reachable from more
    /// places.
    fn reach(self) -> u8 {
        match self {
            Self::Address(_) => 0,
            Self::Loopback => 1,
            Self::Any => 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Port {
    pub number: u16,
    pub bind: Bind,
    /// The listening process's short name, bounded display text.
    pub process: String,
}

impl Port {
    /// Where a browser on this machine reaches the port. A remote port bound
    /// to its own loopback is unreachable from here without a tunnel, and
    /// `localhost` would open whatever this machine runs on the same number.
    pub(crate) fn url(&self, origin: &Origin) -> Option<WebUrl> {
        let name = match (self.bind, origin) {
            (Bind::Address(IpAddr::V6(address)), _) => format!("[{address}]"),
            (Bind::Address(IpAddr::V4(address)), _) => address.to_string(),
            (Bind::Any | Bind::Loopback, Origin::Local) => "localhost".into(),
            (Bind::Loopback, Origin::Remote { .. }) => return None,
            (Bind::Any, Origin::Remote { name, .. }) => name.clone()?,
        };
        WebUrl::try_from(format!("http://{name}:{}/", self.number)).ok()
    }

    /// What clicking the port does: open its page, or first tunnel to a
    /// remote one that listens only on its host's loopback.
    pub(crate) fn link(&self, origin: &Origin) -> Option<Link> {
        match (self.bind, origin) {
            (Bind::Loopback, Origin::Remote { target, .. }) => Some(Link::Tunnel(Key {
                target: target.clone(),
                port: self.number,
            })),
            _ => self.url(origin).map(Link::Page),
        }
    }

    /// `*:3000`, `127.0.0.1:3000`, as a tooltip names the socket.
    pub(crate) fn address(&self) -> String {
        match self.bind {
            Bind::Any => format!("*:{}", self.number),
            Bind::Loopback => format!("localhost:{}", self.number),
            Bind::Address(IpAddr::V6(address)) => format!("[{address}]:{}", self.number),
            Bind::Address(IpAddr::V4(address)) => format!("{address}:{}", self.number),
        }
    }
}

/// Where clicking a port leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Link {
    Page(WebUrl),
    Tunnel(Key),
}

impl Link {
    /// Where it leads, as a menu names it: `localhost:5173`, or `:5173`
    /// for a port reached through a tunnel opened on demand.
    pub(crate) fn label(&self) -> String {
        match self {
            Self::Page(url) => {
                let url = url.as_str();
                let url = url.split_once("://").map_or(url, |(_, rest)| rest);
                url.trim_end_matches('/').to_owned()
            }
            Self::Tunnel(key) => format!(":{}", key.port),
        }
    }
}

/// Where a browser on this machine finds the scanned host.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Origin {
    #[default]
    Local,
    Remote {
        /// The SSH target, which a tunnel to the host dials.
        target: String,
        /// The host's name as a URL spells it, if one could be found.
        name: Option<String>,
    },
}

impl Origin {
    /// `resolved` is the host name SSH configuration gives the target
    /// (`ssh -G`), so an alias such as `devbox` opens at its real `HostName`.
    /// Without one, the target's own host part is the best guess.
    pub(crate) fn new(host: &Host, resolved: Option<&str>) -> Self {
        match host {
            // WSL forwards a distribution's localhost ports to this machine.
            Host::Local | Host::Wsl(_) => Self::Local,
            Host::Ssh(target) => Self::Remote {
                target: target.clone(),
                name: resolved
                    .and_then(url_host)
                    .or_else(|| url_host(target.rsplit('@').next()?)),
            },
        }
    }
}

/// `host` as a URL's host: an IPv6 address in brackets, a name or IPv4
/// address as is, anything else refused.
fn url_host(host: &str) -> Option<String> {
    if let Ok(address) = host.parse::<Ipv6Addr>() {
        return Some(format!("[{address}]"));
    }
    (!host.is_empty() && !host.contains(['/', ':', '[', ']', '@'])).then(|| host.to_owned())
}

/// The pane a listener was started in: its workspace, and the JSON API
/// socket of the daemon that owns it, empty when the process did not say.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) struct Owner {
    pub workspace: String,
    pub socket: String,
}

/// Each workspace's ports, by owner, lowest port first.
pub(crate) type Ports = HashMap<Owner, Vec<Port>>;

/// Parses what [`COMMAND`] printed.
pub(crate) fn parse(text: &str) -> Result<Ports> {
    let mut listeners: Vec<(u32, Port)> = Vec::new();
    let mut owners: HashMap<u32, Owner> = HashMap::new();
    for line in text.lines() {
        let mut words = line.splitn(4, ' ');
        match words.next() {
            Some("N") => return Err(Error::ListeningPortsTool),
            Some("L") if listeners.len() < MAX_LISTENERS => {
                let (Some(pid), Some(address)) = (words.next(), words.next()) else {
                    continue;
                };
                let (Ok(pid), Some(port)) = (pid.parse(), listener(address, words.next())) else {
                    continue;
                };
                listeners.push((pid, port));
            }
            Some("E") => {
                let (Some(pid), Some(workspace)) = (words.next(), words.next()) else {
                    continue;
                };
                let workspace = workspace.trim_end();
                let plain = !workspace.is_empty()
                    && workspace.len() <= MAX_WORKSPACE_ID
                    && workspace.chars().all(|c| c.is_ascii_graphic() && c != '=');
                // Paths are compared, never opened; an unusable one is unknown.
                let socket = words
                    .next()
                    .map(str::trim_end)
                    .filter(|socket| {
                        socket.len() <= MAX_SOCKET && !socket.chars().any(char::is_control)
                    })
                    .unwrap_or_default();
                if let (Ok(pid), true) = (pid.parse(), plain) {
                    owners.insert(
                        pid,
                        Owner {
                            workspace: workspace.to_owned(),
                            socket: socket.to_owned(),
                        },
                    );
                }
            }
            _ => {}
        }
    }
    let mut ports = Ports::new();
    for (pid, port) in listeners {
        let Some(owner) = owners.get(&pid) else {
            continue;
        };
        let list = ports.entry(owner.clone()).or_default();
        match list.iter_mut().find(|known| known.number == port.number) {
            // IPv4 and IPv6 sockets of one server share its number.
            Some(known) => {
                if port.bind.reach() > known.bind.reach() {
                    *known = port;
                }
            }
            None => list.push(port),
        }
    }
    for list in ports.values_mut() {
        list.sort_by_key(|port| port.number);
        list.truncate(MAX_PORTS);
    }
    Ok(ports)
}

/// `127.0.0.1:3000`, `[::1]:3000`, `*:3000`, `0.0.0.0:3000`.
fn listener(address: &str, process: Option<&str>) -> Option<Port> {
    let (host, number) = address.rsplit_once(':')?;
    let number: u16 = number.parse().ok().filter(|number| *number > 0)?;
    Some(Port {
        number,
        bind: Bind::parse(host)?,
        process: process
            .unwrap_or_default()
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_PROCESS)
            .collect::<String>()
            .trim()
            .to_owned(),
    })
}
