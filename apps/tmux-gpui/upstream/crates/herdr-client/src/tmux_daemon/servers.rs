use super::{Error, LocalDaemon};
use crate::tmux_handoff::ServerScope;
use serde::Deserialize;
use std::collections::HashSet;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerRegistration {
    Online { label: String, scope: ServerScope },
    Offline { label: String, server_id: String },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    version: u8,
    servers: Vec<Registration>,
}
#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "lowercase", deny_unknown_fields)]
enum Registration {
    Online {
        #[serde(rename = "serverId")]
        server_id: String,
        label: String,
        generation: String,
    },
    Offline {
        #[serde(rename = "serverId")]
        server_id: String,
        label: String,
        generation: (),
    },
}
impl LocalDaemon {
    /// Fetch server generations only after private-record identity verification.
    /// Always asks the daemon, and remembers the answer for [`Self::known_servers`].
    pub fn list_servers(&self) -> Result<Vec<ServerRegistration>, Error> {
        let (epoch, started) = (known_epoch(), Instant::now());
        let servers = parse(&self.get_resource("api/v1/tmux-servers")?)?;
        remember(self.fingerprint, epoch, started, &servers);
        Ok(servers)
    }
    /// The server list for a check that precedes a scoped request: the one
    /// this daemon generation last sent, if nothing has dropped it, else a new
    /// read. A stale entry cannot reach another server: the generation is in
    /// every scoped URL, the daemon refuses one it retired, and that refusal
    /// drops the list.
    pub(super) fn known_servers(&self) -> Result<Vec<ServerRegistration>, Error> {
        self.remembered_or_listed().map(|(servers, _)| servers)
    }
    /// The servers, and whether they are the remembered list rather than a
    /// read made just now.
    pub(super) fn remembered_or_listed(&self) -> Result<(Vec<ServerRegistration>, bool), Error> {
        self.check_record()?;
        match known(&self.fingerprint) {
            Some(servers) => Ok((servers, true)),
            None => Ok((self.list_servers()?, false)),
        }
    }
}
/// The server list one local daemon generation (its record fingerprint) last
/// sent, and when that read started. Process-wide, like the identity proof:
/// every worker that discovered the same daemon shares it. The app used to
/// ask before every scoped request, eight times to open one session.
///
/// Dropped by: an events change or a lost events lane (where the lane is
/// polled), any failed request to the daemon and a changed or dead record
/// (with the identity proof), a caller that starts over
/// ([`forget_known_servers`]: Refresh, Home, a recovery), and [`KNOWN_AGE`].
/// A restarted daemon has a new record, so nothing of the old one serves it.
/// `drops` counts them: a read that overlapped a drop is not remembered.
struct Known {
    servers: Option<([u8; 32], Instant, Vec<ServerRegistration>)>,
    drops: u64,
}
static KNOWN: std::sync::Mutex<Known> = std::sync::Mutex::new(Known {
    servers: None,
    drops: 0,
});
/// The backstop for a change the events lane did not report (it was down).
pub(super) const KNOWN_AGE: Duration = Duration::from_secs(5);
fn known(fingerprint: &[u8; 32]) -> Option<Vec<ServerRegistration>> {
    if !super::caching() {
        return None;
    }
    let known = KNOWN.lock().ok()?;
    let (owner, at, servers) = known.servers.as_ref()?;
    (owner == fingerprint && at.elapsed() < KNOWN_AGE).then(|| servers.clone())
}
fn known_epoch() -> Option<u64> {
    KNOWN.lock().ok().map(|known| known.drops)
}
fn remember(
    fingerprint: [u8; 32],
    epoch: Option<u64>,
    started: Instant,
    servers: &[ServerRegistration],
) {
    if super::caching()
        && let Ok(mut known) = KNOWN.lock()
        && epoch == Some(known.drops)
    {
        known.servers = Some((fingerprint, started, servers.to_vec()));
    }
}
/// The caller starts over (Refresh, Home, a recovery): what follows asks the
/// daemon, whatever this process read a moment ago.
pub fn forget_known_servers() {
    STARTS_OVER.with(|count| count.set(count.get() + 1));
    forget();
}
thread_local! {
    static STARTS_OVER: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}
/// How often this thread called [`forget_known_servers`], for callers' tests.
#[doc(hidden)]
pub fn starts_over_on_this_thread() -> u64 {
    STARTS_OVER.with(std::cell::Cell::get)
}
/// Something changed, or may have: the next check asks the daemon.
pub(super) fn forget() {
    if super::caching()
        && let Ok(mut known) = KNOWN.lock()
    {
        known.drops = known.drops.wrapping_add(1);
        known.servers = None;
    }
}
/// [`forget`] from any thread, whatever its cache switch.
#[cfg(test)]
pub(super) fn forget_for_tests() {
    let mut known = KNOWN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    known.drops = known.drops.wrapping_add(1);
    known.servers = None;
}
/// Whether a list is remembered for any daemon.
#[cfg(test)]
pub(super) fn remembered() -> bool {
    KNOWN.lock().is_ok_and(|known| known.servers.is_some())
}
#[cfg(test)]
pub(super) fn backdate(by: Duration) {
    if let Ok(mut known) = KNOWN.lock()
        && let Some((_, at, _)) = &mut known.servers
    {
        *at -= by;
    }
}
pub(super) fn parse(bytes: &[u8]) -> Result<Vec<ServerRegistration>, Error> {
    let resource: Resource = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if resource.version != 1 || resource.servers.len() > 4096 {
        return Err(Error::ResourceFormat);
    }
    let mut seen = HashSet::new();
    resource
        .servers
        .into_iter()
        .map(|entry| {
            let (server_id, label, generation) = match entry {
                Registration::Online {
                    server_id,
                    label,
                    generation,
                } => (server_id, label, Some(generation)),
                Registration::Offline {
                    server_id,
                    label,
                    generation: (),
                } => (server_id, label, None),
            };
            let Some(suffix) = server_id.strip_prefix("tmux-server.") else {
                return Err(Error::ResourceFormat);
            };
            if suffix.len() != 32
                || !suffix
                    .bytes()
                    .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
                || !seen.insert(server_id.clone())
            {
                return Err(Error::ResourceFormat);
            }
            let label = label.trim().to_owned();
            if label.is_empty()
                || label.encode_utf16().count() > 160
                || label.chars().any(|v| v < ' ' || v == '\u{7f}')
            {
                return Err(Error::ResourceFormat);
            }
            if let Some(generation) = generation {
                if generation.len() != 36 || uuid::Uuid::parse_str(&generation).is_err() {
                    return Err(Error::ResourceFormat);
                }
                Ok(ServerRegistration::Online {
                    label,
                    scope: ServerScope {
                        server_id,
                        generation,
                    },
                })
            } else {
                Ok(ServerRegistration::Offline { label, server_id })
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "servers_tests.rs"]
mod tests;
