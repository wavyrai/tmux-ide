//! Notification wakeups are private actor scheduling, not helper/UI wire commands.
use super::*;

pub(super) struct Commands {
    sender: mpsc::SyncSender<Command>,
    actor: std::thread::Thread,
}
impl Commands {
    pub(super) fn new(sender: mpsc::SyncSender<Command>, actor: std::thread::Thread) -> Self {
        Self { sender, actor }
    }
    /// A full queue is backpressure: wait for the actor to drain it. Only a closed
    /// actor, or one that drains nothing for two seconds, is an error.
    pub(super) fn send(&self, mut command: Command) -> Result<(), Error> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let result = self.sender.try_send(command);
            self.actor.unpark();
            match result {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Full(pending)) if Instant::now() < deadline => {
                    command = pending;
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(_) => {
                    return Err(Error::Invalid(
                        "native catalog command queue closed or stalled",
                    ));
                }
            }
        }
    }
}
impl Drop for Commands {
    fn drop(&mut self) {
        // Drop the channel before waking, otherwise the actor can observe Empty
        // and park again before its final sender is destroyed.
        let (replacement, _) = mpsc::sync_channel(1);
        drop(std::mem::replace(&mut self.sender, replacement));
        self.actor.unpark();
    }
}
impl Local {
    pub(super) fn watch_tick(&mut self) -> Result<(), Error> {
        if let Some(notice) = self.sources.poll_watch()? {
            self.registry_dirty = true;
            if notice.is_err() {
                self.preferences.refresh();
                self.preference_projection()?;
            }
            if notice.is_err() && self.selected_profile.is_some() {
                // Preserve the uncertain status of any already-submitted mutation
                // through the existing route cancellation boundary.
                self.registry_failed(herdr_client::tmux_daemon::Error::RecordChanged)?;
            }
        }
        if self.registry_dirty && self.stage.is_none() {
            self.registry_dirty = false;
            // A notification is only an invalidation hint. Freshly discover the
            // local owner and reread after any foreground mutation has finished.
            if let Some(worker) = &mut self.registry_worker {
                worker.reset();
            }
            self.read_registry();
        }
        Ok(())
    }
}
