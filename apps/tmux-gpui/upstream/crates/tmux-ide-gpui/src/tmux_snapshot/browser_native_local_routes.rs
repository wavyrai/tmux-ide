//! Shared shutdown ownership follows the selected source, not the startup source.
use super::*;
use std::sync::{Arc, Mutex};
#[path = "browser_native_local_selected_catalog.rs"]
mod catalog;
#[path = "browser_native_local_setup.rs"]
mod setup;
#[derive(Clone)]
pub(in crate::tmux_snapshot) struct Owner(Arc<Mutex<Owned>>);
struct Owned {
    source: CatalogSource,
    stopped: bool,
    catalog: catalog::Gate,
    setup: setup::Gate,
    watch: Option<herdr_client::tmux_daemon::MachineWatchWorker>,
    #[cfg(unix)]
    fleet: Option<background_fleet::Handle>,
}
impl Owner {
    pub(super) fn observation_source(&self) -> Result<CatalogSource, Error> {
        let owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        if owned.stopped {
            return Err(Error::Invalid("native owner closed"));
        }
        Ok(owned.source.clone())
    }

    pub(super) fn new(source: CatalogSource) -> Self {
        Self(Arc::new(Mutex::new(Owned {
            source,
            stopped: false,
            catalog: Default::default(),
            setup: Default::default(),
            watch: None,
            #[cfg(unix)]
            fleet: None,
        })))
    }
    pub(super) fn start_watch(&self, record: Option<PathBuf>) -> Result<(), Error> {
        let Some(record) = record else {
            return Ok(());
        };
        let mut owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        if owned.stopped {
            return Err(Error::Invalid("native owner closed"));
        }
        let actor = std::thread::current();
        owned.watch = Some(herdr_client::tmux_daemon::MachineWatchWorker::spawn(
            record,
            move || actor.unpark(),
        )?);
        Ok(())
    }
    pub(super) fn poll_watch(
        &self,
    ) -> Result<Option<Result<(), herdr_client::tmux_daemon::Error>>, Error> {
        let owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        owned
            .watch
            .as_ref()
            .map(|watch| watch.poll())
            .transpose()
            .map(Option::flatten)
            .map_err(Into::into)
    }
    /// Actor/background only; never called on the active UI thread.
    pub(super) fn replace(
        &self,
        source: CatalogSource,
    ) -> Result<(), herdr_client::tmux_daemon::Error> {
        let mut owned = self
            .0
            .lock()
            .map_err(|_| herdr_client::tmux_daemon::Error::Retired)?;
        if owned.stopped {
            source.shutdown()?;
            return Err(herdr_client::tmux_daemon::Error::Retired);
        }
        owned.catalog.reset();
        owned.setup.cancel();
        owned.source.shutdown()?;
        owned.source = source;
        Ok(())
    }
    #[cfg(unix)]
    pub(super) fn attach_fleet(&self, fleet: background_fleet::Handle) -> Result<(), Error> {
        let mut owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        if owned.stopped {
            fleet
                .lock()
                .map_err(|_| Error::Invalid("fleet owner closed"))?
                .invalidate()?;
            return Err(Error::Invalid("native owner closed"));
        }
        owned.fleet = Some(fleet);
        Ok(())
    }
    pub(in crate::tmux_snapshot) fn shutdown(&self) -> Result<(), Error> {
        let mut owned = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        owned.stopped = true;
        owned.catalog.reset();
        owned.setup.cancel();
        let watch = owned.watch.take();
        let source_result = owned.source.shutdown().map_err(Error::from);
        #[cfg(unix)]
        let fleet_result = owned.fleet.as_ref().map_or(Ok(()), |fleet| {
            fleet
                .lock()
                .map_err(|_| Error::Invalid("fleet owner closed"))?
                .invalidate()
                .map_err(Error::from)
        });
        drop(owned);
        let watch_result = watch.map_or(Ok(()), |watch| watch.shutdown().map_err(Error::from));
        #[cfg(unix)]
        {
            source_result.and(watch_result).and(fleet_result)
        }
        #[cfg(not(unix))]
        {
            source_result.and(watch_result)
        }
    }
}
impl Local {
    pub(super) fn switch_source(
        &mut self,
        request: u64,
        source: CatalogSource,
        id: String,
        label: String,
        profile: Option<herdr_client::tmux_daemon::SavedMachine>,
    ) -> Result<(), Error> {
        let continuation = self.navigation.take_transition(request, &id);
        let tab = self.navigation.tabs.take_transition(request, &id);
        self.cancel()?;
        let worker = CatalogWorker::spawn_source(source.clone())?;
        let split = split::Reader::from_source(source.clone())?;
        self.sources.replace(source)?;
        self.fleet_source_changed();
        self.worker = worker;
        self.split = split;
        self.machine_id = id;
        self.machine_label = label;
        self.selected_profile = profile;
        self.fleet_resync()?;
        // A saved profile reaches this boundary only after its registry reread.
        self.begin_home(request, true)?;
        self.navigation.tabs.restore_transition(tab);
        if let Some(pending) = continuation {
            self.navigation
                .restore_transition(pending, &self.machine_id);
        }
        Ok(())
    }
    pub(super) fn switch_local(&mut self, request: u64) -> Result<(), Error> {
        if request <= self.state.request {
            return Ok(());
        }
        let Some(record) = self.local_record.clone() else {
            self.state.request = request;
            return self.unavailable("Local registry owner was not configured for this entry");
        };
        self.switch_source(
            request,
            CatalogSource::Local(record),
            "local".into(),
            "Local".into(),
            None,
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shutdown_prevents_late_source_adoption() {
        let owner = Owner::new(CatalogSource::Local(PathBuf::from("/unused")));
        assert!(owner.shutdown().is_ok());
        assert!(matches!(
            owner.replace(CatalogSource::Local(PathBuf::from("/also-unused"))),
            Err(herdr_client::tmux_daemon::Error::Retired)
        ));
    }
}
