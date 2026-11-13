//! Selected catalog observation has a separate read lane for Home or an open
//! agent picker. It never resets an interactive source or replays foreground work.
use super::*;
use herdr_client::tmux_daemon::{CatalogWatchWorker, FleetCatalog};
#[derive(Default)]
pub(super) struct Gate {
    watch: Option<CatalogWatchWorker>,
    reader: Option<CatalogWorker>,
    last: Option<FleetCatalog>,
    dirty: bool,
    failure: Option<herdr_client::tmux_daemon::Error>,
    /// A push notification arrived since the agents last asked.
    notified: bool,
    /// The lane sequence `last` is known to reflect: the sequence when the
    /// last completed read started. A drop resumes the lane after it.
    cursor: Option<u64>,
    /// The lane sequence when the current read started.
    reading_from: Option<u64>,
    /// Dropped: the kept catalog waits for Home's retry (`release`).
    held: bool,
    /// Re-armed after a drop: report `Resumed` once the lane is live.
    recovering: bool,
    /// When the kept catalog is read again because a server in it is away,
    /// and how often it was ([`Gate::recheck_due`]).
    recheck: Option<(Instant, u32)>,
    /// Tests: a change the detached lane takes right after the next read is
    /// submitted, so a test sees which side of the submit the cursor was
    /// sampled on.
    #[cfg(test)]
    advance_after_submit: Option<u64>,
}
/// A catalog with a registered server offline, or with no server online, is
/// read again by itself: first after 5 s, then doubling to once a minute. A
/// 2.9.22 daemon looks for an offline server only when it is asked, and says
/// nothing when one comes back, so Home showed "Create a local session to
/// begin" for a tmux server that was running again until someone refreshed
/// (soak, 12 Nov 2026).
const RECHECK_FIRST: Duration = Duration::from_secs(5);
const RECHECK_CAP: Duration = Duration::from_secs(60);
fn server_away(catalog: &FleetCatalog) -> bool {
    let online = |server: &ServerRegistration| matches!(server, ServerRegistration::Online { .. });
    !catalog.servers.iter().all(online) || !catalog.servers.iter().any(online)
}
enum Notice {
    Changed(FleetCatalog),
    Failed(herdr_client::tmux_daemon::Error),
    /// The lane is back after a drop; the kept catalog stands until a change.
    Resumed,
}
impl Gate {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }
    /// Whether the kept catalog is due to be read again for a server that
    /// is away. Each due read doubles the wait; a catalog with every server
    /// online, or none kept, ends it.
    fn recheck_due(&mut self, now: Instant) -> bool {
        if !self.last.as_ref().is_some_and(server_away) {
            self.recheck = None;
            return false;
        }
        let (due, reads) = *self.recheck.get_or_insert((now + RECHECK_FIRST, 0));
        if now < due {
            return false;
        }
        let wait = RECHECK_FIRST
            .saturating_mul(1u32.checked_shl(reads + 1).unwrap_or(u32::MAX))
            .min(RECHECK_CAP);
        self.recheck = Some((now + wait, reads.saturating_add(1)));
        true
    }
    /// How long until the kept catalog is read again, for the actor's wait.
    fn recheck_wait(&self, now: Instant) -> Option<Duration> {
        let (due, _) = self.recheck?;
        Some(
            due.saturating_duration_since(now)
                .max(Duration::from_millis(50)),
        )
    }
    fn cancel_read(&mut self) {
        if self.reader.take().is_some() {
            self.dirty = true;
            self.reading_from = None;
        }
    }
    /// A read starts. Only a live lane's sequence is a safe cursor for it: the
    /// read then reflects at least every change up to that sequence.
    fn read_started(&mut self, live_sequence: Option<u64>) {
        self.reading_from = live_sequence;
    }
    /// The read completed for the same daemon: its start becomes the cursor.
    /// A read without a live lane keeps the older cursor, which only replays
    /// more.
    fn read_completed(&mut self) {
        if let Some(sequence) = self.reading_from.take() {
            self.cursor = Some(sequence);
        }
    }
    /// A connection drop: end the lane and any read, keep the catalog and the
    /// cursor, and wait for Home's retry before connecting again.
    fn drop_link(&mut self) {
        self.cancel_read();
        self.watch.take();
        self.failure = None;
        self.held = true;
    }
    /// Home's retry is due. True when the kept catalog can be resumed rather
    /// than read again from scratch.
    fn release(&mut self) -> bool {
        if !self.held || self.last.is_none() {
            return false;
        }
        self.held = false;
        self.recovering = true;
        true
    }
    fn seed(&mut self, snapshot: &FleetCatalog) {
        if self
            .last
            .as_ref()
            .is_some_and(|last| last.identity != snapshot.identity)
        {
            self.reset();
        }
        self.last = Some(snapshot.clone());
    }
    /// A read completed. The same daemon's catalog becomes the cursor's
    /// base; a different daemon fails the lane.
    fn on_read(
        &mut self,
        result: Result<CatalogResult, herdr_client::tmux_daemon::Error>,
    ) -> Result<Option<Notice>, Error> {
        match result {
            Ok(CatalogResult::FleetCatalog(snapshot)) => {
                if self
                    .last
                    .as_ref()
                    .is_none_or(|last| last.identity != snapshot.identity)
                {
                    return Ok(Some(Notice::Failed(
                        herdr_client::tmux_daemon::Error::IdentityChanged,
                    )));
                }
                self.read_completed();
                if self.last.as_ref() != Some(&snapshot) {
                    self.last = Some(snapshot.clone());
                    // What is away now starts its own count.
                    self.recheck = None;
                    return Ok(Some(Notice::Changed(snapshot)));
                }
                Ok(None)
            }
            Ok(_) => Err(Error::Invalid("unexpected selected catalog response")),
            Err(error) => Ok(Some(Notice::Failed(error))),
        }
    }
    fn poll(
        &mut self,
        source: &CatalogSource,
        visible: bool,
        eligible: bool,
    ) -> Result<Option<Notice>, Error> {
        if !visible {
            self.cancel_read();
            self.watch.take();
            self.recheck = None;
            return Ok(None);
        }
        if !eligible {
            self.cancel_read();
        }
        if eligible
            && self.watch.is_none()
            && self.failure.is_none()
            && !self.held
            && let Some(last) = &self.last
        {
            let actor = std::thread::current();
            // After a drop, replay only what changed since the cursor.
            let after = self.cursor.filter(|_| self.recovering);
            self.watch = Some(CatalogWatchWorker::resume(
                source.clone(),
                last.identity.clone(),
                after,
                move || actor.unpark(),
            )?);
        }
        if let Some(notice) = self
            .watch
            .as_ref()
            .map(|watch| watch.poll())
            .transpose()?
            .flatten()
        {
            match notice {
                Ok(()) => {
                    self.dirty = true;
                    self.notified = true;
                }
                Err(error) => {
                    self.watch.take();
                    self.reader.take();
                    self.failure = Some(herdr_client::tmux_daemon::Error::CatalogWatch(Box::new(
                        error,
                    )));
                }
            }
        }
        if !eligible {
            return Ok(None);
        }
        if let Some(error) = self.failure.take() {
            return Ok(Some(Notice::Failed(error)));
        }
        if self.recovering && self.watch.as_ref().is_some_and(CatalogWatchWorker::live) {
            self.recovering = false;
            return Ok(Some(Notice::Resumed));
        }
        if let Some(result) = self
            .reader
            .as_mut()
            .map(|reader| reader.poll())
            .transpose()?
            .flatten()
        {
            self.reader.take();
            return self.on_read(result);
        }
        if self.reader.is_none() && self.recheck_due(Instant::now()) {
            self.dirty = true;
        }
        if self.dirty && self.reader.is_none() && self.last.is_some() {
            // Sampled before the read is submitted: the read then reflects at
            // least every change up to it. Only a live lane's sequence counts.
            self.read_started(self.watch.as_ref().and_then(CatalogWatchWorker::read_start));
            let mut reader = CatalogWorker::spawn_source(source.clone())?;
            reader.submit(CatalogAction::FleetCatalog)?;
            #[cfg(test)]
            if let (Some(sequence), Some(watch)) = (self.advance_after_submit.take(), &self.watch) {
                watch.advance_detached(sequence);
            }
            self.reader = Some(reader);
            self.dirty = false;
        }
        Ok(None)
    }
}
impl Owner {
    pub(in crate::tmux_snapshot) fn seed_catalog(
        &self,
        snapshot: &FleetCatalog,
    ) -> Result<(), Error> {
        let mut owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        if owned.stopped {
            return Err(Error::Invalid("native owner closed"));
        }
        owned.catalog.seed(snapshot);
        Ok(())
    }
    pub(in crate::tmux_snapshot) fn reset_catalog(&self) -> Result<(), Error> {
        self.0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?
            .catalog
            .reset();
        Ok(())
    }
    pub(in crate::tmux_snapshot) fn drop_catalog_link(&self) -> Result<(), Error> {
        self.0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?
            .catalog
            .drop_link();
        Ok(())
    }
    pub(in crate::tmux_snapshot) fn release_catalog(&self) -> Result<bool, Error> {
        Ok(self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?
            .catalog
            .release())
    }
    pub(in crate::tmux_snapshot) fn cancel_catalog_read(&self) -> Result<(), Error> {
        self.0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?
            .catalog
            .cancel_read();
        Ok(())
    }
    pub(in crate::tmux_snapshot) fn catalog_busy(&self) -> Result<bool, Error> {
        Ok(self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?
            .catalog
            .reader
            .is_some())
    }
    pub(in crate::tmux_snapshot) fn catalog_snapshot(&self) -> Result<Option<FleetCatalog>, Error> {
        let owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        Ok(if owned.stopped {
            None
        } else {
            owned.catalog.last.clone()
        })
    }
    /// Whether the selected catalog's daemon pushes fleet changes (registered
    /// servers, sessions, agents), and whether one arrived since the last call.
    pub(in crate::tmux_snapshot) fn catalog_push(&self) -> Result<(bool, bool), Error> {
        let mut owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        let catalog = &mut owned.catalog;
        let push = catalog
            .watch
            .as_ref()
            .is_some_and(CatalogWatchWorker::fleet_push);
        Ok((push, std::mem::take(&mut catalog.notified)))
    }
    /// How long until the selected catalog reads itself again for a server
    /// that is away; `None` when nothing is.
    pub(in crate::tmux_snapshot) fn catalog_recheck_wait(&self) -> Option<Duration> {
        let owned = self.0.lock().ok()?;
        owned.catalog.recheck_wait(Instant::now())
    }
    fn poll_catalog(&self, visible: bool, eligible: bool) -> Result<Option<Notice>, Error> {
        let mut owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        if owned.stopped {
            return Ok(None);
        }
        let source = owned.source.clone();
        owned.catalog.poll(&source, visible, eligible)
    }
}
impl Local {
    pub(in crate::tmux_snapshot) fn selected_catalog_tick(&mut self) -> Result<(), Error> {
        let home = self.state.surface == Surface::Home && self.state.home_phase == HomePhase::Live;
        let visible = self.foreground
            && (home || self.workspace_catalog_observing() || self.picker_observing());
        let notice = self
            .sources
            .poll_catalog(visible, visible && self.stage.is_none())?;
        // With fleet push, agent rows refresh on the daemon's notice, not a timer.
        let (push, notified) = self.sources.catalog_push()?;
        self.agents.pushed(push, notified, &self.machine_id);
        match notice {
            Some(Notice::Changed(snapshot)) if home => self.receive_catalog(snapshot, false),
            Some(Notice::Changed(snapshot)) => self.picker_catalog(&snapshot),
            Some(Notice::Failed(_)) if !home => self.workspace_catalog_failed(),
            Some(Notice::Resumed) if home => self.home_resumed(),
            Some(Notice::Resumed) => Ok(()),
            Some(Notice::Failed(error)) => self.home_catalog_failed(error),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "browser_native_local_selected_catalog_tests.rs"]
mod tests;
