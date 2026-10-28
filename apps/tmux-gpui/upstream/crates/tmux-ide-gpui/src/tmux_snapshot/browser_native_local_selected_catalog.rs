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
}
enum Notice {
    Changed(FleetCatalog),
    Failed(herdr_client::tmux_daemon::Error),
}
impl Gate {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }
    fn cancel_read(&mut self) {
        if self.reader.take().is_some() {
            self.dirty = true;
        }
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
    fn poll(
        &mut self,
        source: &CatalogSource,
        visible: bool,
        eligible: bool,
    ) -> Result<Option<Notice>, Error> {
        if !visible {
            self.cancel_read();
            self.watch.take();
            return Ok(None);
        }
        if !eligible {
            self.cancel_read();
        }
        if eligible
            && self.watch.is_none()
            && self.failure.is_none()
            && let Some(last) = &self.last
        {
            let actor = std::thread::current();
            self.watch = Some(CatalogWatchWorker::spawn(
                source.clone(),
                last.identity.clone(),
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
                Ok(()) => self.dirty = true,
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
        if let Some(result) = self
            .reader
            .as_mut()
            .map(|reader| reader.poll())
            .transpose()?
            .flatten()
        {
            self.reader.take();
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
                    if self.last.as_ref() != Some(&snapshot) {
                        self.last = Some(snapshot.clone());
                        return Ok(Some(Notice::Changed(snapshot)));
                    }
                }
                Ok(_) => return Err(Error::Invalid("unexpected selected catalog response")),
                Err(error) => return Ok(Some(Notice::Failed(error))),
            }
        }
        if self.dirty && self.reader.is_none() && self.last.is_some() {
            let mut reader = CatalogWorker::spawn_source(source.clone())?;
            reader.submit(CatalogAction::FleetCatalog)?;
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
        match self
            .sources
            .poll_catalog(visible, visible && self.stage.is_none())?
        {
            Some(Notice::Changed(snapshot)) if home => self.receive_catalog(snapshot, false),
            Some(Notice::Changed(snapshot)) => self.picker_catalog(&snapshot),
            Some(Notice::Failed(_)) if !home => self.workspace_catalog_failed(),
            Some(Notice::Failed(_error)) => {
                self.unavailable("Catalog connection changed — refresh to reconnect")
            }
            None => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "browser_native_local_selected_catalog_tests.rs"]
mod tests;
