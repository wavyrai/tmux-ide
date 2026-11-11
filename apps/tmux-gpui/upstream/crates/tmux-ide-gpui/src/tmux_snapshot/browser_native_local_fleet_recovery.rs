//! Read-only recovery of remote machines, authorized only by a fresh local
//! registry read. A transient failure is retried until the user disconnects
//! (owner, r4): 1, 2, 4… seconds, capped at a minute. Authentication, host
//! keys and other failures only the user can fix are never retried.
use super::*;
use herdr_client::tmux_daemon::Error as DaemonError;
/// The longest wait between two tries of an unreachable machine.
pub(in crate::tmux_snapshot) const MAX_DELAY: Duration = Duration::from_secs(60);
#[derive(Default)]
pub(super) struct Retries(BTreeMap<String, Attempt>);
struct Attempt {
    incarnation: uuid::Uuid,
    count: u32,
    due: Option<Instant>,
    pending: bool,
    /// When the machine was first found unreachable in this run of failures.
    since: (Instant, std::time::SystemTime),
}
/// The delay before try `count + 1`.
pub(super) fn delay(count: u32) -> Duration {
    Duration::from_secs(1u64.checked_shl(count.min(16)).unwrap_or(u64::MAX)).min(MAX_DELAY)
}
impl Retries {
    pub(super) fn success(&mut self, id: &str) {
        self.0.remove(id);
    }
    pub(super) fn retain(
        &mut self,
        labels: &BTreeMap<String, (String, uuid::Uuid)>,
        disconnected: &BTreeSet<String>,
    ) {
        self.0.retain(|id, attempt| {
            !disconnected.contains(id) && labels.get(id).is_some_and(|v| v.1 == attempt.incarnation)
        });
    }
    pub(super) fn failed(
        &mut self,
        id: &str,
        incarnation: uuid::Uuid,
        error: &DaemonError,
        now: Instant,
    ) {
        if !transient(error) {
            self.0.remove(id);
            return;
        }
        let attempt = self.0.entry(id.into()).or_insert(Attempt {
            incarnation,
            count: 0,
            due: None,
            pending: false,
            since: (now, std::time::SystemTime::now()),
        });
        if attempt.incarnation == incarnation && attempt.due.is_none() && !attempt.pending {
            attempt.due = Some(now + delay(attempt.count));
        }
    }
    /// When an unreachable machine was first found so, while it is retried.
    pub(super) fn away(&self, id: &str) -> Option<(Instant, std::time::SystemTime)> {
        self.0.get(id).map(|attempt| attempt.since)
    }
    fn wait(&self, now: Instant) -> Option<Duration> {
        self.0
            .values()
            .filter_map(|a| a.due)
            .min()
            .map(|due| due.saturating_duration_since(now))
    }
    fn request(&mut self, now: Instant) -> bool {
        let mut requested = false;
        for attempt in self.0.values_mut() {
            if attempt.due.is_some_and(|due| due <= now) {
                attempt.due = None;
                attempt.pending = true;
                requested = true;
            }
        }
        requested
    }
}
fn transient(error: &DaemonError) -> bool {
    error.is_transient_catalog_failure()
}
impl Local {
    fn fleet_recovery_eligible(&self) -> bool {
        self.foreground
            && self.state.surface == Surface::Home
            && self.state.home_phase == HomePhase::Live
    }
    pub(in crate::tmux_snapshot) fn fleet_recovery_wait(&self) -> Option<Duration> {
        self.fleet_recovery_eligible()
            .then(|| self.background_fleet.recovery.wait(Instant::now()))
            .flatten()
    }
    pub(super) fn fleet_recovery_tick(&mut self) {
        if self.fleet_recovery_eligible()
            && self.stage.is_none()
            && self.background_fleet.recovery.request(Instant::now())
        {
            if let Some(worker) = &mut self.registry_worker {
                worker.reset();
            }
            self.read_registry();
        }
    }
    pub(in crate::tmux_snapshot) fn fleet_recovery_fresh(&mut self) -> Result<(), Error> {
        if !self.fleet_recovery_eligible() || self.background_fleet.pending_control.is_some() {
            for attempt in self.background_fleet.recovery.0.values_mut() {
                if std::mem::take(&mut attempt.pending) {
                    attempt.due = Some(Instant::now() + Duration::from_secs(1));
                }
            }
            return Ok(());
        }
        #[cfg(unix)]
        if let Some(registry) = &self.background_fleet.registry {
            let mut registry = registry
                .lock()
                .map_err(|_| Error::Invalid("fleet owner closed"))?;
            for (id, attempt) in &mut self.background_fleet.recovery.0 {
                if !std::mem::take(&mut attempt.pending) || registry.disconnected(id) {
                    continue;
                }
                if let Some(next) = registry.retry(id, attempt.incarnation)? {
                    attempt.count = attempt.count.saturating_add(1);
                    attempt.incarnation = next;
                    if let Some(label) = self.background_fleet.labels.get_mut(id) {
                        label.1 = next;
                    }
                    // The last known sessions stay listed, muted, while it is away.
                    self.background_fleet.failed.remove(id);
                    self.background_fleet
                        .selections
                        .retain(|_, s| s.machine != *id);
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
#[path = "browser_native_local_fleet_recovery_tests.rs"]
mod tests;
