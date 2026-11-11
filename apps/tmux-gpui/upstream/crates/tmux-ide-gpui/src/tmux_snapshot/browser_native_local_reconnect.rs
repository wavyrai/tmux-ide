//! Recovery after a lost terminal stream. While the daemon is the same one, the
//! app re-issues a lease for the same session and keeps retrying with backoff; the
//! terminal loop keeps the last frame on screen meanwhile. Only a changed daemon
//! sends recovery through rediscovery, which also keeps the window as it was
//! until it ends. A new daemon authorizes an old server generation only for
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
/// The stop a session recovery ends in, for the act-needed card (r3).
pub(super) const GAVE_UP: &str = GIVE_UP;
pub(super) struct Recovery {
    target: Target,
    pane: Option<String>,
    attempts: u32,
    due: Option<Instant>,
    others: u8,
    /// The private local record recovery began on; `None` for any remote source.
    local_record: Option<PathBuf>,
    /// Over SSH: the saved machine and the remote environment recovery began
    /// on, the machine half of what may reopen across daemon generations.
    remote: Option<(String, String)>,
    /// `Some` while the daemon is the one the stream was issued by.
    rebind: Option<Rebind>,
    /// The daemon was unreachable: rediscover its record before the next try.
    rediscover_owner: bool,
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
            others: 0,
            local_record: None,
            remote: None,
            rebind: None,
            rediscover_owner: false,
        }
    }
    pub(super) fn waiting(&self) -> bool {
        self.due.is_some()
    }
    /// Shown as the attempt count beside the Reconnecting badge.
    pub(super) fn attempt(&self) -> u32 {
        self.attempts.max(1)
    }
}
/// Backoff doubles from 250 ms to this cap and never gives up on the same daemon.
const MAX_DELAY: Duration = Duration::from_secs(30);
/// Other and identity failures rediscovery takes before it stops: a budget for
/// the whole recovery, never refilled by a catalog listing (only a stream that
/// is ready again ends a recovery), so at most about ten minutes at the cap.
const MAX_OTHERS: u8 = 20;
const GIVE_UP: &str = "Couldn't reconnect. Refresh sessions to try again.";
/// Over SSH a different identity may be a different machine: stop at once.
pub(super) const SSH_IDENTITY: &str =
    "A different daemon answered for this machine. Check the machine, then refresh sessions.";
/// The daemon now speaks a protocol this app does not: only an app update helps.
pub(super) const UPDATE_APP: &str =
    "tmux-ide was updated and this app can no longer talk to it. Update the app to reconnect.";
pub(super) const RECONNECTING: &str = "Connection lost. Reconnecting…";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    /// Retried with backoff, forever.
    Unreachable,
    /// A different daemon answered, or a stale record named the old one while
    /// the new one already answered. A rebind turns into rediscovery. Locally,
    /// rediscovery reads the record again and backs off, from the same budget
    /// as [`Failure::Other`]; over SSH it stops at once ([`SSH_IDENTITY`]).
    Identity,
    /// The daemon speaks another protocol: recovery ends with [`UPDATE_APP`].
    Incompatible,
    /// A rebind turns into rediscovery; rediscovery backs off, and stops after
    /// [`MAX_OTHERS`] in a row without a catalog listing the session.
    Other,
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
        let Some(route) = self.active.as_ref() else {
            return Ok(());
        };
        if matches!(self.stage, Some(Stage::Owner { .. } | Stage::Create { .. })) {
            return self
                .unavailable("Connection lost during an action — refresh to inspect its outcome");
        }
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
        let recovery = self.recovery.take().unwrap_or_else(|| Recovery {
            target: route.target.clone(),
            pane: self.state.selected_pane.clone(),
            attempts: 0,
            due: None,
            others: 0,
            local_record: self.current_local_record(),
            remote: self.current_remote(),
            rebind,
            rediscover_owner: false,
        });
        self.cancel()?;
        self.recovery = Some(recovery);
        self.reconnect_retry(Failure::Unreachable)
    }
    /// Schedule the next try. Same-daemon failures back off from 250 ms to 30 s and
    /// never give up; a changed daemon ends a rebind and starts rediscovery.
    pub(super) fn reconnect_retry(&mut self, failure: Failure) -> Result<(), Error> {
        let Some(recovery) = self.recovery.as_mut() else {
            return Ok(());
        };
        if failure == Failure::Incompatible {
            return self.unavailable(UPDATE_APP);
        }
        if recovery.rebind.is_some() && failure != Failure::Unreachable {
            // Not the daemon or session the stream came from: look it up again.
            recovery.rebind = None;
            recovery.others = 0;
        } else if recovery.rebind.is_none() {
            if failure == Failure::Identity && recovery.local_record.is_none() {
                return self.unavailable(SSH_IDENTITY);
            }
            if matches!(failure, Failure::Other | Failure::Identity) {
                recovery.others = recovery.others.saturating_add(1);
            }
            if recovery.others > MAX_OTHERS {
                return self.unavailable(GIVE_UP);
            }
        }
        recovery.rediscover_owner |= failure == Failure::Unreachable && recovery.attempts > 0;
        let delay = Duration::from_millis(250)
            .saturating_mul(
                1u32.checked_shl(recovery.attempts.min(16))
                    .unwrap_or(u32::MAX),
            )
            .min(MAX_DELAY);
        recovery.due = Some(Instant::now() + delay);
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
        if !self.foreground
            || self
                .recovery
                .as_ref()
                .is_none_or(|r| r.due.is_none_or(|due| Instant::now() < due))
        {
            return Ok(());
        }
        let Some(mut recovery) = self.recovery.take() else {
            return Ok(());
        };
        recovery.attempts = recovery.attempts.saturating_add(1);
        recovery.due = None;
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
        let Some(recovery) = self.recovery.take() else {
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
            self.unavailable(
                "Previous session identity changed or disappeared — select a session",
            )?;
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
mod tests;
