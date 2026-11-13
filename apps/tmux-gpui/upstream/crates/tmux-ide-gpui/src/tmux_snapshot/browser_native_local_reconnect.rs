//! Recovery after a lost terminal stream. The first try is at once: a lease for
//! the same session from the daemon the stream came from. Every failed try reads
//! the daemon record again and backs off, to a cap, for as long as the window is
//! open, active or not; the terminal loop keeps the last frame on screen
//! meanwhile. A daemon that no longer knows the generation or session sends
//! recovery through rediscovery, which also keeps the window as it was. Recovery
//! ends only when the stream is ready, when the session ended (its server is
//! online without it, or stayed away for [`AWAY_LIMIT`]), or on a stop no
//! retry can pass
//! ([`UPDATE_APP`], [`SSH_IDENTITY`]). A new daemon authorizes an old server generation only for
//! the same local daemon record, or over SSH the same saved machine and remote
//! environment, with the identical server and live session
//! (`reconnect_catalog`), so retrying through a daemon update can never bind
//! the window to another session. An identity failure over SSH stops at once,
//! and recovery never repeats owner mutations.
use super::*;

/// What a rebind needs to re-issue a lease without reading the catalog again.
#[derive(Clone)]
struct Rebind {
    workspace: String,
    panes: Vec<String>,
    selected: String,
}
/// The stop an unrecoverable stream identity ends in, for the act-needed card (r3).
pub(super) const GAVE_UP: &str = "Couldn't reconnect. Refresh sessions to try again.";
pub(super) struct Recovery {
    target: Target,
    pane: Option<String>,
    attempts: u32,
    due: Option<Instant>,
    /// The private local record recovery began on; `None` for any remote source.
    local_record: Option<PathBuf>,
    /// Over SSH: the saved machine and the remote environment recovery began
    /// on, the machine half of what may reopen across daemon generations.
    remote: Option<(String, String)>,
    /// `Some` while the daemon is the one the stream was issued by.
    rebind: Option<Rebind>,
    /// A try failed: read the daemon record again before the next one.
    rediscover_owner: bool,
    /// The session's name when the stream dropped, for [`Local::session_ended`].
    label: Option<String>,
    /// Since when every catalog has listed the session's server as away.
    away_since: Option<Instant>,
    /// The daemon record as the last try found it ([`record_stamp`]).
    record: Option<Stamp>,
    /// Since when every catalog has listed the server online without the session.
    missing_since: Option<Instant>,
    /// The daemon said the session's last pane exited: one catalog that
    /// lacks the session is then enough.
    ended: bool,
    /// A stream of this recovery already failed its identity check once.
    identity_retried: bool,
}
/// A daemon record's modification time and size. A restarted daemon writes a
/// new record, so a change means the next try need not wait out its backoff.
type Stamp = (std::time::SystemTime, u64);
fn record_stamp(record: Option<&PathBuf>) -> Option<Stamp> {
    let metadata = std::fs::metadata(record?).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}
/// A stream that drops again within [`SETTLED`] of its recovery continues that
/// recovery's backoff, so a flapping daemon is not retried in a tight loop.
///
/// A close the daemon itself sent is different: the daemon was reachable a
/// moment ago, so the next try is at once and the backoff starts over
/// (PM, 12 Nov: the owner's daemon closed streams three times in 44 s while it
/// stayed up). At most [`FRESH`] such starts per [`FRESH_WINDOW`]; a daemon
/// that closes more often than that is flapping and gets the backoff.
#[derive(Default)]
pub(super) struct Flap {
    recovered: Option<(Instant, u32)>,
    fresh: std::collections::VecDeque<Instant>,
}
const SETTLED: Duration = Duration::from_secs(5);
const FRESH: usize = 4;
const FRESH_WINDOW: Duration = Duration::from_secs(10);
impl Flap {
    /// A recovery ended in a ready stream after `attempts` tries.
    pub(super) fn recovered(&mut self, attempts: u32) {
        self.recovered = Some((Instant::now(), attempts));
    }
    /// The tries a new recovery starts from: none after a settled stream.
    fn carried(&mut self) -> u32 {
        self.recovered
            .take()
            .filter(|(at, _)| at.elapsed() < SETTLED)
            .map_or(0, |(_, attempts)| attempts)
    }
    /// Whether a close sent by the daemon may start the backoff over now.
    fn fresh(&mut self) -> bool {
        let now = Instant::now();
        self.fresh
            .retain(|at| now.saturating_duration_since(*at) < FRESH_WINDOW);
        if self.fresh.len() >= FRESH {
            return false;
        }
        self.fresh.push_back(now);
        true
    }
    #[cfg(test)]
    pub(super) fn age(&mut self, by: Duration) {
        if let Some((at, _)) = &mut self.recovered {
            *at -= by;
        }
        for at in &mut self.fresh {
            *at -= by;
        }
    }
}
impl Recovery {
    /// A recovery of `target` that is due now, for tests outside this module.
    #[cfg(test)]
    pub(super) fn of(target: Target) -> Self {
        Self {
            target,
            pane: None,
            attempts: 1,
            due: None,
            local_record: None,
            remote: None,
            rebind: None,
            rediscover_owner: false,
            label: None,
            away_since: None,
            record: None,
            missing_since: None,
            ended: false,
            identity_retried: false,
        }
    }
    pub(super) fn waiting(&self) -> bool {
        self.due.is_some()
    }
    /// Shown as the attempt count beside the Reconnecting badge.
    pub(super) fn attempt(&self) -> u32 {
        self.attempts.max(1)
    }
    /// The tries so far, for [`Flap`].
    pub(super) fn attempts(&self) -> u32 {
        self.attempts
    }
    /// The wait before the next try: none before the first, then 250 ms
    /// doubling to the cap. A local try is a record read and a loopback
    /// request; over SSH it may start a transport, so the cap is longer.
    fn delay(&self) -> Duration {
        let Some(failed) = self.attempts.checked_sub(1) else {
            return Duration::ZERO;
        };
        let cap = if self.local_record.is_some() {
            MAX_DELAY_LOCAL
        } else {
            MAX_DELAY_REMOTE
        };
        Duration::from_millis(250)
            .saturating_mul(1u32.checked_shl(failed.min(16)).unwrap_or(u32::MAX))
            .min(cap)
    }
}
const MAX_DELAY_LOCAL: Duration = Duration::from_secs(5);
const MAX_DELAY_REMOTE: Duration = Duration::from_secs(30);
/// How long the session's server may stay offline or unlisted, in catalogs the
/// daemon did answer, before the session counts as ended. A daemon that lost
/// sight of a live server finds it again within a probe or two; a server that
/// was killed never comes back. Also how long a server may be online with no
/// session at all before the open one counts as ended: an owner that was
/// just rebuilt may not have listed its sessions yet.
const AWAY_LIMIT: Duration = Duration::from_secs(30);
/// How long a server that lists other sessions may lack the open one before
/// it counts as ended. Never one read: a second catalog, at least this much
/// later, must agree.
const MISSING_LIMIT: Duration = Duration::from_secs(2);
/// Over SSH a different identity may be a different machine: stop at once.
pub(super) const SSH_IDENTITY: &str =
    "A different machine answered at this address. Check the machine, then refresh sessions.";
/// The daemon now speaks a protocol this app does not: only an app update helps.
pub(super) const UPDATE_APP: &str = "Tmux IDE's background service was updated and this app can no longer talk to it. Update the app to reconnect.";
pub(super) const RECONNECTING: &str = "Connection lost. Reconnecting…";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    /// Retried with backoff, for as long as the window is open.
    Unreachable,
    /// A different daemon answered, or a stale record named the old one while
    /// the new one already answered. A rebind turns into rediscovery. Locally,
    /// rediscovery reads the record again and backs off; over SSH it stops at
    /// once ([`SSH_IDENTITY`]).
    Identity,
    /// The daemon speaks another protocol: recovery ends with [`UPDATE_APP`].
    Incompatible,
    /// A rebind turns into rediscovery; rediscovery backs off and tries again.
    Other,
    /// The catalog was read, but the session's server is offline or not
    /// listed: the daemon may only have lost sight of it. Tried again.
    Away,
    /// The catalog was read and the server is online without the session.
    /// Tried again until [`MISSING_LIMIT`] or [`AWAY_LIMIT`] confirms it.
    Missing,
}
impl Failure {
    pub(super) fn of(error: &herdr_client::tmux_daemon::Error) -> Self {
        use herdr_client::tmux_daemon::Error as E;
        match error {
            E::Network(_) | E::RecordChanged | E::OwnerExited => Self::Unreachable,
            E::RecordIo(error) if error.kind() == std::io::ErrorKind::NotFound => Self::Unreachable,
            E::IdentityFormat | E::IdentityChanged => Self::Identity,
            // The saved machine's expected environment answered with another.
            #[cfg(unix)]
            E::Remote(remote) if remote_environment_mismatch(remote) => Self::Identity,
            E::Incompatible(_) => Self::Incompatible,
            _ => Self::Other,
        }
    }
}
#[cfg(unix)]
fn remote_environment_mismatch(remote: &herdr_client::tmux_ssh::TransportError) -> bool {
    use herdr_client::tmux_ssh::{DiscoveryError, Error, TransportError};
    matches!(
        remote,
        TransportError::Discovery(DiscoveryError::Descriptor(Error::Environment))
    )
}
impl Local {
    pub(super) fn reconnect_start(&mut self) -> Result<(), Error> {
        self.reconnect_after(Cause::Lost)
    }
    /// Starts or continues recovery after the stream ended for `cause`. Every
    /// cause reconnects; it only picks the first step and the first wait.
    pub(super) fn reconnect_after(&mut self, cause: Cause) -> Result<(), Error> {
        let Some(route) = self.active.as_ref() else {
            return Ok(());
        };
        let panes: Vec<String> = self.state.panes.iter().map(|p| p.id.clone()).collect();
        let rebind = self
            .state
            .selected_pane
            .clone()
            .filter(|pane| panes.contains(pane))
            .or_else(|| panes.first().cloned())
            .map(|selected| Rebind {
                workspace: route.workspace.clone(),
                panes: panes.clone(),
                selected,
            });
        let label = (self.state.sessions.iter())
            .find(|choice| choice.id == route.target.live)
            .map(|choice| choice.label.clone());
        let carried = self.flap.carried();
        // The daemon closed the stream itself: it is there. Try now, from the
        // start of the backoff, also when a recovery was already under way.
        let fresh = cause.daemon_spoke() && self.flap.fresh();
        let mut recovery = self.recovery.take().unwrap_or_else(|| Recovery {
            target: route.target.clone(),
            pane: self.state.selected_pane.clone(),
            attempts: carried,
            due: None,
            local_record: self.current_local_record(),
            remote: self.current_remote(),
            rebind,
            rediscover_owner: false,
            label,
            away_since: None,
            // The record as it is now: only a later rewrite hurries a try.
            record: record_stamp(self.current_local_record().as_ref()),
            missing_since: None,
            ended: false,
            identity_retried: false,
        });
        if fresh {
            recovery.attempts = 0;
        }
        match cause {
            // The generation is gone with the retired owner, and a restarting
            // daemon comes back with a new one: a lease for the old one can
            // only be refused. Read the catalog (and the record) instead.
            Cause::ServerRetired | Cause::DaemonRestarting => recovery.rebind = None,
            Cause::PanesClosed => {
                recovery.rebind = None;
                recovery.ended = true;
            }
            // One fresh lease, then the catalog: never a stop (PM, 12 Nov).
            Cause::Identity if std::mem::replace(&mut recovery.identity_retried, true) => {
                recovery.rebind = None;
            }
            Cause::Identity | Cause::Closed | Cause::Lost | Cause::Silent => {}
        }
        // A drop, not navigation: agents and the catalog stay on screen. An
        // action in flight is cancelled, never replayed; a session creation
        // keeps its uncertain id (`drop_link`).
        self.drop_link()?;
        self.recovery = Some(recovery);
        self.reconnect_schedule()
    }
    /// Opening `target` failed before it had a stream: recover it through the
    /// catalog, as a dropped session is, with the same ends (ready, the
    /// session ended, navigation, a stop no retry can pass).
    pub(super) fn reconnect_opening(
        &mut self,
        target: Target,
        pane: Option<String>,
        failure: Failure,
    ) -> Result<(), Error> {
        let label = (self.state.sessions.iter())
            .find(|choice| choice.id == target.live)
            .map(|choice| choice.label.clone());
        self.recovery = Some(Recovery {
            target,
            pane,
            attempts: 0,
            due: None,
            local_record: self.current_local_record(),
            remote: self.current_remote(),
            rebind: None,
            rediscover_owner: false,
            label,
            away_since: None,
            record: record_stamp(self.current_local_record().as_ref()),
            missing_since: None,
            ended: false,
            identity_retried: false,
        });
        self.reconnect_retry(failure)
    }
    /// The stream's lease no longer fits the session's panes (one was added or
    /// closed elsewhere): recover through the catalog, which lists them as
    /// they are now, and do it now. Not a failed try, so no backoff.
    pub(super) fn reconnect_refresh(&mut self, preferred: Option<String>) -> Result<(), Error> {
        self.reconnect_start()?;
        if let Some(recovery) = self.recovery.as_mut() {
            recovery.rebind = None;
            recovery.pane = preferred.or(recovery.pane.take());
            recovery.due = Some(Instant::now());
        }
        Ok(())
    }
    /// A try failed: schedule the next. Nothing but [`Failure::Incompatible`]
    /// and an SSH identity change ends recovery; a daemon that no longer knows
    /// the generation or session ends a rebind and starts rediscovery.
    pub(super) fn reconnect_retry(&mut self, failure: Failure) -> Result<(), Error> {
        let Some(recovery) = self.recovery.as_mut() else {
            return Ok(());
        };
        if failure == Failure::Incompatible {
            return self.unavailable(UPDATE_APP);
        }
        if recovery.rebind.is_some() && failure != Failure::Unreachable {
            // Not the daemon or session the stream came from: look it up again,
            // now. The daemon answered, so this is news, not a failure to wait
            // out, and it happens once per recovery.
            recovery.rebind = None;
            recovery.rediscover_owner = true;
            recovery.due = Some(Instant::now());
            self.stage = None;
            self.submitted = false;
            self.state.status = RECONNECTING.into();
            return self.publish();
        } else if recovery.rebind.is_none()
            && failure == Failure::Identity
            && recovery.local_record.is_none()
        {
            return self.unavailable(SSH_IDENTITY);
        }
        if failure != Failure::Away {
            recovery.away_since = None;
        }
        if failure != Failure::Missing {
            recovery.missing_since = None;
        }
        // The record may name a new port or token by now.
        recovery.rediscover_owner = true;
        self.reconnect_schedule()
    }
    fn reconnect_schedule(&mut self) -> Result<(), Error> {
        let Some(recovery) = self.recovery.as_mut() else {
            return Ok(());
        };
        recovery.due = Some(Instant::now() + recovery.delay());
        self.stage = None;
        self.submitted = false;
        self.state.status = RECONNECTING.into();
        self.publish()
    }
    /// The Retry button: try now instead of waiting out the backoff.
    pub(super) fn reconnect_now(&mut self, request: u64) -> Result<(), Error> {
        if request != self.state.request {
            return Ok(());
        }
        if let Some(recovery) = self.recovery.as_mut()
            && recovery.due.is_some()
        {
            recovery.due = Some(Instant::now());
        }
        self.home.retry_now(Instant::now());
        Ok(())
    }
    pub(super) fn reconnect_tick(&mut self) -> Result<(), Error> {
        // Active or not: a visible window must not stay frozen until clicked.
        let Some(waiting) = self.recovery.as_ref().filter(|r| r.due.is_some()) else {
            return Ok(());
        };
        // A rewritten daemon record is a restarted daemon: try it now.
        let stamp = record_stamp(waiting.local_record.as_ref());
        let rewritten = stamp.is_some() && stamp != waiting.record;
        if !rewritten && waiting.due.is_some_and(|due| Instant::now() < due) {
            return Ok(());
        }
        let Some(mut recovery) = self.recovery.take() else {
            return Ok(());
        };
        recovery.attempts = recovery.attempts.saturating_add(1);
        recovery.due = None;
        recovery.record = stamp;
        if let Some(rebind) = recovery.rebind.clone() {
            // Same daemon: one lease request for the same session, no Home reset.
            if std::mem::take(&mut recovery.rediscover_owner) {
                self.worker.reset();
            }
            self.stage = Some(Stage::Issue {
                target: recovery.target.clone(),
                workspace: rebind.workspace,
                panes: rebind.panes,
                selected: rebind.selected,
            });
            self.submitted = false;
            self.recovery = Some(recovery);
            self.state.status = RECONNECTING.into();
            return self.publish();
        }
        // Rediscovery keeps the window as it was: no Home, no loading state.
        self.background_fleet.refresh();
        self.restart_discovery(false)?;
        self.state.status = RECONNECTING.into();
        self.recovery = Some(recovery);
        self.publish()
    }
    /// Whether the fresh catalog lists the session's server as online: the
    /// exact generation, or any generation of it when `known` (the same local
    /// record or saved machine).
    fn server_online(&self, scope: &ServerScope, known: bool) -> bool {
        let listed = (self.state.fleet.iter())
            .flat_map(|fleet| fleet.groups.first())
            .flat_map(|group| &group.servers)
            .any(|server| {
                server.state == fleet::ServerPhase::Online
                    && server.id == scope.server_id
                    && (known || server.generation.as_ref() == Some(&scope.generation))
            });
        // A server that lists any session is online.
        listed
            || self.targets.values().any(|target| {
                target.scope.server_id == scope.server_id
                    && (known || target.scope.generation == scope.generation)
            })
    }
    /// Whether the fresh catalog lists any session of `server`.
    fn lists_sessions(&self, server: &str) -> bool {
        (self.targets.values()).any(|target| target.scope.server_id == server)
    }
    /// The session is gone from a server that answered, or its server is gone:
    /// Home, freshly loaded, with a notice that says so. Every other session
    /// stays one click away.
    fn session_ended(&mut self, label: Option<&str>, gone: &str) -> Result<(), Error> {
        let label = label.map_or_else(|| "The session".to_owned(), |l| format!("“{l}”"));
        let notice = format!("{label} ended: its tmux {gone} is no longer running.");
        let request = self.state.request;
        self.home(request)?;
        self.state.home_notice = Some(notice);
        self.publish()
    }
    fn current_local_record(&self) -> Option<PathBuf> {
        match self.sources.observation_source().ok()? {
            CatalogSource::Local(record) if self.selected_profile.is_none() => Some(record),
            _ => None,
        }
    }
    /// The saved machine and remote environment the catalog came from, when
    /// both are known: an SSH profile, and a daemon that reports its
    /// environment id (minted once per state home, kept across restarts).
    /// A selected profile is what makes the source remote, so a local record
    /// never has one.
    fn current_remote(&self) -> Option<(String, String)> {
        let profile = self.selected_profile.as_ref()?.id.clone();
        let environment = self.catalog_identity.as_ref()?.environment_id.clone()?;
        Some((profile, environment))
    }
    /// Select an exact generation/session match in the newly verified catalog. A
    /// restarted local daemon has a new generation; its live session id hashes the
    /// tmux server pid, session id and creation time, so an identical id on the
    /// same server and the same private record is the same tmux session.
    pub(super) fn reconnect_catalog(&mut self) -> Result<bool, Error> {
        let Some(mut recovery) = self.recovery.take() else {
            return Ok(false);
        };
        let same_local_daemon =
            recovery.local_record.is_some() && recovery.local_record == self.current_local_record();
        // Over SSH (owner, D): the same saved machine and the same remote
        // environment, both known on both sides. Then the server id and the
        // live id (server pid, session id, creation time) decide, as locally.
        let same_remote_machine =
            recovery.remote.is_some() && recovery.remote == self.current_remote();
        let key = self
            .targets
            .iter()
            .find(|(_, target)| {
                target.scope == recovery.target.scope && target.live == recovery.target.live
            })
            .or_else(|| {
                self.targets.iter().find(|(_, target)| {
                    (same_local_daemon || same_remote_machine)
                        && target.scope.server_id == recovery.target.scope.server_id
                        && target.live == recovery.target.live
                })
            })
            .map(|(key, _)| key.clone());
        let Some(key) = key else {
            let known = same_local_daemon || same_remote_machine;
            let server = &recovery.target.scope.server_id;
            if self.server_online(&recovery.target.scope, known) {
                // The server answered and does not list the session. One read
                // is not proof unless the daemon also said its panes closed.
                let limit = if self.lists_sessions(&recovery.target.scope.server_id) {
                    MISSING_LIMIT
                } else {
                    AWAY_LIMIT
                };
                let since = *recovery.missing_since.get_or_insert_with(Instant::now);
                if recovery.ended || !known || since.elapsed() >= limit {
                    return self
                        .session_ended(recovery.label.as_deref(), "session")
                        .map(|()| true);
                }
                eprintln!("tmux-ide: reconnect: server {server} does not list the session yet");
                self.recovery = Some(recovery);
                self.reconnect_retry(Failure::Missing)?;
            } else if known {
                // Offline or unlisted: the daemon may only have lost sight of
                // the server (a slow probe). The session may still be there.
                let since = *recovery.away_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= AWAY_LIMIT {
                    return self
                        .session_ended(recovery.label.as_deref(), "server")
                        .map(|()| true);
                }
                eprintln!("tmux-ide: reconnect: server {server} is not online yet");
                self.recovery = Some(recovery);
                self.reconnect_retry(Failure::Away)?;
            } else {
                self.unavailable(
                    "Previous session identity changed or disappeared — select a session",
                )?;
            }
            return Ok(true);
        };
        self.open(self.state.request, key, recovery.pane.clone())?;
        // A session now over the pane limit is refused with a notice and no
        // stage; nothing would retry it, so its recovery ends here.
        if self.state.home_notice.is_none() {
            self.recovery = Some(recovery);
        }
        Ok(true)
    }
}

#[cfg(test)]
#[path = "browser_native_local_reconnect_tests.rs"]
pub(super) mod tests;
