//! Bounded read-only recovery, authorized only by a fresh local registry read.
use super::*;
use herdr_client::tmux_daemon::Error as DaemonError;
#[derive(Default)]
pub(super) struct Retries(BTreeMap<String, Attempt>);
struct Attempt {
    incarnation: uuid::Uuid,
    count: u8,
    due: Option<Instant>,
    pending: bool,
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
        });
        if attempt.incarnation == incarnation
            && attempt.count < 3
            && attempt.due.is_none()
            && !attempt.pending
        {
            attempt.due = Some(now + Duration::from_secs(1 << attempt.count));
        }
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
                    attempt.count += 1;
                    attempt.incarnation = next;
                    if let Some(label) = self.background_fleet.labels.get_mut(id) {
                        label.1 = next;
                    }
                    self.background_fleet.catalogs.remove(id);
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
