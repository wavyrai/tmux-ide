//! A Home that stopped because its sessions could not be loaded keeps looking
//! for the daemon, quietly: the daemon was not running yet when the app
//! started, launchd is bringing it back, or no tmux server was online. What
//! the window shows does not change until a load succeeds; then Home appears
//! as after Refresh. A local daemon is probed every five seconds at most (one
//! record read and a loopback request); an SSH machine every thirty seconds
//! at most, since a try may start an SSH connection. A saved machine's profile
//! is read again from the local registry and must be unchanged before each
//! try reads its catalog (#853), as a refresh does. In an active or inactive
//! window. A stop that only the user can clear never arms it.
use super::*;

const FIRST: Duration = Duration::from_secs(1);
const CAP_LOCAL: Duration = Duration::from_secs(5);
const CAP_REMOTE: Duration = Duration::from_secs(30);
#[derive(Default)]
pub(super) struct Quiet {
    due: Option<Instant>,
    tries: u32,
    probing: bool,
    /// The source is an SSH machine: the longer cap.
    remote: bool,
}
impl Quiet {
    fn delay(&self) -> Duration {
        let cap = if self.remote { CAP_REMOTE } else { CAP_LOCAL };
        FIRST
            .saturating_mul(1u32.checked_shl(self.tries.min(16)).unwrap_or(u32::MAX))
            .min(cap)
    }
    pub(super) fn probing(&self) -> bool {
        self.probing
    }
    pub(super) fn wait(&self, now: Instant) -> Option<Duration> {
        self.due.map(|due| due.saturating_duration_since(now))
    }
    #[cfg(test)]
    pub(super) fn due_now(&mut self) -> bool {
        self.due.replace(Instant::now()).is_some()
    }
}
impl Local {
    /// Home stops with `status` and keeps looking for its daemon.
    pub(super) fn unavailable_retrying(&mut self, status: &'static str) -> Result<(), Error> {
        let tries = self.home.quiet.tries;
        self.unavailable(status)?;
        let remote = !matches!(
            self.sources.observation_source(),
            Ok(CatalogSource::Local(_))
        );
        let mut quiet = Quiet {
            tries,
            remote,
            ..Quiet::default()
        };
        quiet.due = Some(Instant::now() + quiet.delay());
        self.home.quiet = quiet;
        Ok(())
    }
    /// Starts the next quiet load when it is due. Publishes nothing.
    pub(super) fn quiet_tick(&mut self) -> Result<(), Error> {
        if self.home.quiet.due.is_none_or(|due| Instant::now() < due) || self.stage.is_some() {
            return Ok(());
        }
        let stopped = self.state.surface == Surface::Home
            && self.state.home_phase == HomePhase::Unavailable
            && self.active.is_none()
            && self.recovery.is_none();
        if !stopped {
            self.home.quiet = Quiet::default();
            return Ok(());
        }
        self.home.quiet.due = None;
        self.home.quiet.probing = true;
        self.home.quiet.tries = self.home.quiet.tries.saturating_add(1);
        // A fresh discovery: the record may be new, or there for the first time.
        self.sources.reset_catalog()?;
        self.worker.reset();
        self.targets.clear();
        self.catalog_identity = None;
        self.stage = Some(if self.selected_profile.is_some() {
            // The registry first; its answer starts the catalog read only
            // for the same, still enabled profile (`registry_received`).
            self.registry.begin();
            Stage::VerifyProfile
        } else {
            Stage::Servers
        });
        self.submitted = false;
        Ok(())
    }
    /// A registry read or change failed. When it was a quiet try verifying
    /// the saved machine, no catalog is read, and the window stays on that
    /// machine until the next try, as after a failed catalog read. Otherwise
    /// the saved route is retired, as before.
    pub(super) fn registry_stage_failed(
        &mut self,
        stage: &Stage,
        error: herdr_client::tmux_daemon::Error,
    ) -> Result<(), Error> {
        if self.home.quiet.probing() && matches!(stage, Stage::VerifyProfile) {
            if let Some(worker) = &mut self.registry_worker {
                worker.reset();
            }
            self.registry.finish(Err(error));
            self.home.quiet.probing = false;
            self.home.quiet.due = Some(Instant::now() + self.home.quiet.delay());
            return Ok(());
        }
        let selecting = matches!(
            stage,
            Stage::MachineSelection { .. } | Stage::AddMachine { .. }
        );
        self.registry_failed(error)?;
        if selecting {
            self.unavailable("Saved machine verification failed — refresh and select it again")?;
        }
        Ok(())
    }
    /// The quiet load failed: the window stays as it is until the next one,
    /// unless why it failed changed what Home should say (a daemon that was
    /// unreachable now answers 503 for its tmux server, or the reverse).
    /// Only those two sentences are replaced; a failure for the same reason
    /// publishes nothing.
    pub(super) fn quiet_failed(
        &mut self,
        error: &herdr_client::tmux_daemon::Error,
    ) -> Result<(), Error> {
        self.home.quiet.probing = false;
        self.home.quiet.due = Some(Instant::now() + self.home.quiet.delay());
        let words = self.stopped_words(true, error);
        let shown = self.state.status.as_str();
        if shown != words
            && (shown == open_retry::TMUX_NOT_ANSWERING || shown == open_retry::REFRESH_TO_RETRY)
        {
            self.state.status = words.into();
            return self.publish();
        }
        Ok(())
    }
    /// The quiet load answered: Home starts over, as after Refresh.
    pub(super) fn quiet_found(&mut self) {
        if std::mem::take(&mut self.home.quiet.probing) {
            self.state = State {
                request: self.state.request,
                home_phase: HomePhase::Loading,
                status: "Loading sessions".into(),
                ..State::default()
            };
        }
    }
}
