//! Home reconnects by itself after its catalog connection drops: a daemon
//! restart or update, a stopped or frozen daemon, a closed events socket, a
//! failed session list. The last good list stays on screen with a quiet
//! "Reconnecting…" line, and each retry is a fresh discovery: the daemon record
//! is read again and its identity proved before any credentials are sent, so a
//! new daemon is accepted only through that proof, never from the old link.
//! Only a failure that cannot recover by itself stops with a reason.
use super::*;
use herdr_client::tmux_daemon::{CatalogEventError, CatalogWatchError, Error as DaemonError};

/// Backoff doubles from 250 ms to this cap, for as long as Home is in front.
/// A retry is a record read and one loopback request, so a short cap costs
/// little and brings Home back within seconds of a restarted daemon.
const MAX_DELAY: Duration = Duration::from_secs(5);
pub(super) const RECONNECTING: &str = "Reconnecting…";
pub(super) const STILL_RECONNECTING: &str = "Still reconnecting…";
const CREDENTIALS: &str = "The daemon refused this app's credentials. Restart tmux-ide.";
const UNREADABLE: &str = "The daemon sent data this app can't read. Refresh to try again.";
/// Protocol failures in a row before Home stops and says so.
const PROTOCOL_LIMIT: u8 = 3;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum HomeFailure {
    /// Retried with backoff for as long as Home is in front.
    Retry,
    /// Retried, but the same failure three times in a row stops.
    Protocol,
    /// Will not recover by itself: Home keeps its list and says why.
    Fatal(&'static str),
}
pub(super) fn classify(error: &DaemonError) -> HomeFailure {
    use HomeFailure::{Fatal, Protocol, Retry};
    match error {
        DaemonError::Incompatible(_) => {
            Fatal("This daemon needs an update. Update tmux-ide, then refresh.")
        }
        DaemonError::RecordFormat | DaemonError::RecordSecurity | DaemonError::Endpoint => {
            Fatal("tmux-ide's daemon record is unreadable. Refresh after fixing it.")
        }
        DaemonError::RequestStatus(401 | 403) => Fatal(CREDENTIALS),
        DaemonError::UnsupportedPlatform => {
            Fatal("This platform can't verify the daemon. Refresh to try again.")
        }
        DaemonError::IdentityFormat
        | DaemonError::ResourceFormat
        | DaemonError::Control(_)
        | DaemonError::Capability(_) => Protocol,
        DaemonError::CatalogWatch(watch) => match watch.as_ref() {
            CatalogWatchError::Owner(owner) => classify(owner),
            // The events socket's upgrade was refused for its credentials.
            refused if refused.refused_credentials() => Fatal(CREDENTIALS),
            // A bad frame, identity or retired lane: a fresh read decides.
            CatalogWatchError::Protocol(
                CatalogEventError::Frame | CatalogEventError::Identity | CatalogEventError::Retired,
            ) => Protocol,
            // Socket I/O, a reset, any close (including the daemon's 1013
            // "reconnect and reseed"), a deadline, an unavailable lane.
            _ => Retry,
        },
        // A restart, an update, a gone process, a moved record, a busy
        // daemon, a failed session list, a lost tunnel: all read-only to retry.
        _ => Retry,
    }
}

#[derive(Default)]
pub(super) struct Recovery {
    /// `Some` while Home is reconnecting.
    active: Option<Attempt>,
    /// Set when Home stopped on a failure that won't recover by itself.
    fault: Option<&'static str>,
}
struct Attempt {
    attempts: u32,
    due: Option<Instant>,
    protocol: u8,
}
impl Recovery {
    pub(super) fn active(&self) -> bool {
        self.active.is_some()
    }
    /// Shown as the attempt count beside "Reconnecting…".
    pub(super) fn attempt(&self) -> Option<u32> {
        self.active.as_ref().map(|a| a.attempts.max(1))
    }
    /// "Reconnecting…", then "Reconnecting… attempt N" once a retry has failed.
    fn status(&self) -> String {
        match self.active.as_ref().map(|a| a.attempts) {
            Some(tried) if tried > 0 => format!("{RECONNECTING} attempt {}", tried + 1),
            _ => RECONNECTING.into(),
        }
    }
    pub(super) fn wait(&self, now: Instant) -> Option<Duration> {
        self.active
            .as_ref()
            .and_then(|a| a.due)
            .map(|due| due.saturating_duration_since(now))
    }
    pub(super) fn fault(&self) -> Option<&'static str> {
        self.fault
    }
    pub(super) fn retry_now(&mut self, now: Instant) {
        if let Some(attempt) = self.active.as_mut()
            && attempt.due.is_some()
        {
            attempt.due = Some(now);
        }
    }
    /// Records a failure; `Err` carries the message of one that stops Home.
    fn failed(&mut self, failure: HomeFailure, now: Instant) -> Result<(), &'static str> {
        let attempt = self.active.get_or_insert(Attempt {
            attempts: 0,
            due: None,
            protocol: 0,
        });
        match failure {
            HomeFailure::Fatal(message) => return Err(message),
            HomeFailure::Protocol => {
                attempt.protocol += 1;
                if attempt.protocol >= PROTOCOL_LIMIT {
                    return Err(UNREADABLE);
                }
            }
            HomeFailure::Retry => attempt.protocol = 0,
        }
        let delay = Duration::from_millis(250)
            .saturating_mul(
                1u32.checked_shl(attempt.attempts.min(16))
                    .unwrap_or(u32::MAX),
            )
            .min(MAX_DELAY);
        attempt.due = Some(now + delay);
        Ok(())
    }
    /// Takes the attempt that is due, if any.
    fn due(&mut self, now: Instant) -> bool {
        let Some(attempt) = self.active.as_mut() else {
            return false;
        };
        if attempt.due.is_none_or(|due| now < due) {
            return false;
        }
        attempt.due = None;
        attempt.attempts = attempt.attempts.saturating_add(1);
        true
    }
}

impl Local {
    fn home_visible(&self) -> bool {
        self.foreground
            && self.state.surface == Surface::Home
            && self.state.home_phase == HomePhase::Live
    }
    /// Home's catalog failed: keep the list, drop the dead link, and retry.
    pub(super) fn home_catalog_failed(&mut self, error: DaemonError) -> Result<(), Error> {
        // Bounded messages only: codes and numbers, no payloads.
        eprintln!("tmux-ide: Home catalog failed: {error}");
        match self.home.failed(classify(&error), Instant::now()) {
            Ok(()) => {
                // A retry is a fresh discovery: nothing from the old link is kept.
                self.sources.reset_catalog()?;
                self.worker.reset();
                self.home.fault = None;
                self.state.status = self.home.status();
            }
            Err(message) => {
                self.sources.reset_catalog()?;
                self.home = Recovery {
                    active: None,
                    fault: Some(message),
                };
                self.state.status = message.into();
            }
        }
        self.publish()
    }
    /// How long the idle actor may park before Home's next retry.
    /// None in the background or off Home: nothing runs there, so a due retry
    /// must not keep the actor awake.
    pub(super) fn home_recovery_wait(&self) -> Option<Duration> {
        self.home_visible()
            .then(|| self.home.wait(Instant::now()))
            .flatten()
    }
    pub(super) fn home_recovery_tick(&mut self) -> Result<(), Error> {
        if self.stage.is_some() || !self.home_visible() || !self.home.due(Instant::now()) {
            return Ok(());
        }
        self.stage = Some(Stage::Servers);
        self.submitted = false;
        self.state.status = self.home.status();
        self.publish()
    }
    /// A fresh catalog arrived: the next one replaces the kept list whole.
    pub(super) fn home_recovered(&mut self) {
        if self.home.active.take().is_some() {
            self.targets.clear();
        }
        self.home.fault = None;
    }
    /// Opening a session waits for Home to reconnect, and is refused with the
    /// reason after a failure that won't recover by itself.
    pub(super) fn home_open_blocked(&mut self) -> Result<bool, Error> {
        let status = match (self.home.active(), self.home.fault) {
            (true, _) => STILL_RECONNECTING,
            (false, Some(reason)) => reason,
            (false, None) => return Ok(false),
        };
        self.state.status = status.into();
        self.publish()?;
        Ok(true)
    }
}

#[cfg(test)]
#[path = "browser_native_local_home_recovery_tests.rs"]
mod tests;
