//! Recovery after a lost terminal stream. While the daemon is the same one, the
//! app re-issues a lease for the same session and keeps retrying with backoff; the
//! terminal loop keeps the last frame on screen meanwhile. Only a changed daemon
//! sends recovery through rediscovery. A new daemon authorizes an old server
//! generation only for a local restart with the identical live session, and
//! recovery never repeats owner mutations.
use super::*;

/// What a rebind needs to re-issue a lease without reading the catalog again.
#[derive(Clone)]
struct Rebind {
    workspace: String,
    panes: Vec<String>,
    selected: String,
}
pub(super) struct Recovery {
    target: Target,
    pane: Option<String>,
    attempts: u32,
    due: Option<Instant>,
    others: u8,
    /// The private local record recovery began on; `None` for any remote source.
    local_record: Option<PathBuf>,
    /// `Some` while the daemon is the one the stream was issued by.
    rebind: Option<Rebind>,
    /// The daemon was unreachable: rediscover its record before the next try.
    rediscover_owner: bool,
}
impl Recovery {
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
const GIVE_UP: &str = "Couldn't reconnect. Refresh sessions to try again.";
pub(super) const RECONNECTING: &str = "Connection lost. Reconnecting…";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    /// Retried with backoff, forever.
    Unreachable,
    /// A different daemon answered. A rebind turns into rediscovery; rediscovery
    /// stops.
    Identity,
    /// A rebind turns into rediscovery; rediscovery retries at most three times.
    Other,
}
impl Failure {
    pub(super) fn of(error: &herdr_client::tmux_daemon::Error) -> Self {
        use herdr_client::tmux_daemon::Error as E;
        match error {
            E::Network(_) | E::RecordChanged | E::OwnerExited => Self::Unreachable,
            E::RecordIo(error) if error.kind() == std::io::ErrorKind::NotFound => Self::Unreachable,
            E::IdentityFormat | E::IdentityChanged | E::Incompatible(_) => Self::Identity,
            _ => Self::Other,
        }
    }
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
        if recovery.rebind.is_some() && failure != Failure::Unreachable {
            // Not the daemon or session the stream came from: look it up again.
            recovery.rebind = None;
            recovery.others = 0;
        } else if recovery.rebind.is_none() {
            if failure == Failure::Other {
                recovery.others += 1;
            }
            if failure == Failure::Identity || recovery.others > 3 {
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
        let request = self.state.request;
        self.home(request)?;
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
        let key = self
            .targets
            .iter()
            .find(|(_, target)| {
                target.scope == recovery.target.scope && target.live == recovery.target.live
            })
            .or_else(|| {
                self.targets.iter().find(|(_, target)| {
                    same_local_daemon
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
        self.recovery = Some(recovery);
        Ok(true)
    }
}

#[cfg(test)]
#[path = "browser_native_local_reconnect_tests.rs"]
mod tests;
