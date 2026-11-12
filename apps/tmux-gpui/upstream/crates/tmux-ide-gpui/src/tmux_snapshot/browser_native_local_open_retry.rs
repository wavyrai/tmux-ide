//! A session the daemon opens without listing a pane is opened again, for
//! about three seconds, before the window says so. The daemon may not have
//! listed the pane of a session it has only just created: the app used to
//! stop at once on "Session has no attachable terminal panes", and only a
//! refresh got the user into the session they had just made.
use super::*;

pub(super) const NO_PANES: &str = "Session has no attachable terminal panes";
/// Tries in all: the first open, then one after 100, 200, 400, 800 and 1600 ms.
const TRIES: u32 = 6;
struct Waiting {
    request: u64,
    target: Target,
    preferred: Option<String>,
    /// Opens that listed no pane so far.
    empty: u32,
    due: Instant,
}
#[derive(Default)]
pub(super) struct EmptyOpen(Option<Waiting>);
impl EmptyOpen {
    #[cfg(test)]
    pub(super) fn due_now(&mut self) {
        if let Some(waiting) = &mut self.0 {
            waiting.due = Instant::now();
        }
    }
}
impl Local {
    /// The daemon opened `target` and listed no pane to attach.
    pub(super) fn opened_without_panes(
        &mut self,
        target: Target,
        preferred: Option<String>,
    ) -> Result<(), Error> {
        if self.recovery.is_some() {
            // The session is listed again but its panes are not: one more
            // failed try of the recovery, which reads the catalog again.
            eprintln!("tmux-ide: reconnect: the session has no attachable pane yet");
            return self.reconnect_retry(reconnect::Failure::Other);
        }
        let request = self.state.request;
        let empty = (self.empty_open.0.take())
            .filter(|w| {
                w.request == request
                    && w.target.live == target.live
                    && w.target.scope == target.scope
            })
            .map_or(0, |w| w.empty)
            + 1;
        if empty >= TRIES {
            return self.unavailable(NO_PANES);
        }
        self.empty_open.0 = Some(Waiting {
            request,
            target,
            preferred,
            empty,
            due: Instant::now() + Duration::from_millis(50u64 << empty),
        });
        Ok(())
    }
    /// Opens the session again when its wait is over. Navigation, a recovery
    /// or a stream ends the tries.
    pub(super) fn empty_open_tick(&mut self) -> Result<(), Error> {
        let Some(waiting) = self.empty_open.0.as_ref() else {
            return Ok(());
        };
        if waiting.request != self.state.request
            || self.state.surface != Surface::Workspace
            || self.recovery.is_some()
            || self.active.is_some()
        {
            self.empty_open.0 = None;
            return Ok(());
        }
        if self.stage.is_some() || Instant::now() < waiting.due {
            return Ok(());
        }
        self.stage = Some(Stage::Open {
            target: waiting.target.clone(),
            preferred: waiting.preferred.clone(),
        });
        self.submitted = false;
        Ok(())
    }
    /// How long until the next try, for the actor's idle wait.
    pub(super) fn empty_open_wait(&self) -> Option<Duration> {
        let waiting = self.empty_open.0.as_ref()?;
        // While its open is under way nothing is due.
        self.stage
            .is_none()
            .then(|| waiting.due.saturating_duration_since(Instant::now()))
    }
}

#[cfg(test)]
#[path = "browser_native_local_open_retry_tests.rs"]
mod tests;
