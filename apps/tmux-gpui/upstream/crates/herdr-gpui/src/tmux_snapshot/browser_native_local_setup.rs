//! Owned setup work has no UI-thread IO and no automatic daemon startup.
use super::*;
use crate::tmux_snapshot::browser::local_setup::{Phase, Setup};
use std::sync::atomic::{AtomicBool, Ordering};
struct Job {
    request: u64,
    cancel: Arc<AtomicBool>,
    result: mpsc::Receiver<Option<Phase>>,
}
impl Drop for Job {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
    }
}
#[derive(Default)]
pub(super) struct Gate {
    job: Option<Job>,
}
fn home_for(record: &std::path::Path) -> Option<PathBuf> {
    // Managed production setup must not start a personal daemon for an isolated
    // record. Alternate namespaces remain explicit CLI setup workflows.
    if [
        "TMUX_IDE_RUNTIME_MODE",
        "TMUX_IDE_STATE_HOME",
        "TMUX_IDE_REGISTRY_DIR",
        "TMUX_IDE_DAEMON_INFO_DIR",
    ]
    .iter()
    .any(|key| std::env::var_os(key).is_some_and(|v| !v.is_empty()))
    {
        return None;
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    (home.is_absolute() && record == home.join(".tmux-ide/daemon.json")).then_some(home)
}
impl Gate {
    pub(super) fn cancel(&mut self) {
        self.job = None;
    }
    fn start(&mut self, request: u64, record: &std::path::Path, run: bool) -> Result<bool, Error> {
        if self.job.is_some() {
            return Ok(false);
        }
        let Some(home) = home_for(record) else {
            return Ok(false);
        };
        self.start_home(request, home, run)
    }
    fn start_home(&mut self, request: u64, home: PathBuf, run: bool) -> Result<bool, Error> {
        if self.job.is_some() {
            return Ok(false);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = cancel.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        let actor = std::thread::current();
        std::thread::Builder::new()
            .name("tmux-local-setup".into())
            .spawn(move || {
                #[cfg(unix)]
                let phase = {
                    use herdr_client::tmux_daemon::{LocalSetupError, resolve_local_setup};
                    match resolve_local_setup(&home) {
                        Ok(installation) if run => match installation.run(&stop) {
                            Ok(()) => None,
                            Err(LocalSetupError::Stopped) => Some(Phase::StoppedWaiting),
                            Err(_) => Some(Phase::Failed),
                        },
                        Ok(_) => Some(Phase::Available),
                        Err(LocalSetupError::Missing) => Some(Phase::Missing),
                        Err(_) => Some(Phase::Unsupported),
                    }
                };
                #[cfg(not(unix))]
                let phase = {
                    let _ = (home, run);
                    Some(Phase::Unsupported)
                };
                if !stop.load(Ordering::Acquire) {
                    let _ = tx.send(phase);
                    actor.unpark();
                }
            })
            .map_err(|_| Error::Invalid("local setup worker unavailable"))?;
        self.job = Some(Job {
            request,
            cancel,
            result: rx,
        });
        Ok(true)
    }
}
impl Owner {
    pub(in crate::tmux_snapshot) fn cancel_setup(&self) -> Result<(), Error> {
        self.0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?
            .setup
            .cancel();
        Ok(())
    }
    fn setup_start(
        &self,
        request: u64,
        record: &std::path::Path,
        run: bool,
    ) -> Result<bool, Error> {
        let mut owner = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        if owner.stopped {
            return Ok(false);
        }
        owner.setup.start(request, record, run)
    }
    fn setup_poll(&self) -> Result<Option<(u64, Option<Phase>)>, Error> {
        let mut owner = self
            .0
            .lock()
            .map_err(|_| Error::Invalid("native owner closed"))?;
        let Some(job) = &owner.setup.job else {
            return Ok(None);
        };
        let phase = match job.result.try_recv() {
            Ok(phase) => phase,
            Err(mpsc::TryRecvError::Empty) => return Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Some(Phase::Failed),
        };
        let request = job.request;
        owner.setup.job = None;
        Ok(Some((request, phase)))
    }
}
impl Local {
    pub(in crate::tmux_snapshot) fn offer_local_setup(&mut self) -> Result<(), Error> {
        if self.machine_id == "local"
            && self.foreground
            && let Some(record) = &self.local_record
        {
            self.sources
                .setup_start(self.state.request, record, false)?;
        }
        Ok(())
    }
    pub(in crate::tmux_snapshot) fn start_local_setup(
        &mut self,
        request: u64,
    ) -> Result<(), Error> {
        if request != self.state.request
            || !self.foreground
            || self.stage.is_some()
            || self.machine_id != "local"
            || self.state.surface != Surface::Home
            || self
                .state
                .local_setup
                .as_ref()
                .is_none_or(|s| !s.phase.actionable())
        {
            return Ok(());
        }
        if let Some(record) = &self.local_record
            && self.sources.setup_start(request, record, true)?
        {
            self.state.local_setup = Some(Setup {
                phase: Phase::Running,
            });
            self.publish()?;
        }
        Ok(())
    }
    pub(in crate::tmux_snapshot) fn setup_presence(&mut self, active: bool) -> Result<(), Error> {
        if !active {
            self.sources.cancel_setup()?;
            if self
                .state
                .local_setup
                .as_ref()
                .is_some_and(|s| s.phase == Phase::Running)
            {
                self.state.local_setup = Some(Setup {
                    phase: Phase::StoppedWaiting,
                });
                self.publish()?;
            }
        }
        Ok(())
    }
    pub(in crate::tmux_snapshot) fn setup_tick(&mut self) -> Result<(), Error> {
        if let Some((request, phase)) = self.sources.setup_poll()?
            && request == self.state.request
            && self.foreground
            && self.machine_id == "local"
            && self.state.surface == Surface::Home
        {
            if let Some(phase) = phase {
                self.state.local_setup = Some(Setup { phase });
                self.publish()?;
            } else {
                self.home(request)?;
            }
        }
        Ok(())
    }
}

#[cfg(all(test, unix))]
#[path = "browser_native_local_setup_tests.rs"]
mod tests;
