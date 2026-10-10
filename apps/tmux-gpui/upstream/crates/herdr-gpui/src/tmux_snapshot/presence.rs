//! Keep a background transition until queued, even across rapid reactivation.
use super::browser::Command;
use std::sync::mpsc::SyncSender;

pub(super) struct Presence {
    active: bool,
    pending_background: bool,
    last_queued: Option<bool>,
    revision: u64,
    acknowledged: u64,
}
impl Presence {
    pub(super) fn new(active: bool) -> Self {
        Self {
            active,
            pending_background: !active,
            last_queued: None,
            revision: 0,
            acknowledged: 0,
        }
    }
    pub(super) fn set_active(&mut self, active: bool) {
        self.active = active;
        self.pending_background |= !active;
    }
    pub(super) fn active(&self) -> bool {
        self.active
    }
    pub(super) fn ready(&self) -> bool {
        self.active
            && !self.pending_background
            && self.last_queued == Some(true)
            && self.revision == self.acknowledged
    }
    pub(super) fn acknowledge(&mut self, revision: u64) {
        if revision == self.revision {
            self.acknowledged = revision;
        }
    }
    pub(super) fn flush(&mut self, sender: &SyncSender<Command>) {
        if self.revision >= 9_007_199_254_740_990 {
            return;
        }
        if self.pending_background {
            if sender
                .try_send(Command::Presence {
                    active: false,
                    revision: self.revision + 1,
                })
                .is_err()
            {
                return;
            }
            self.revision += 1;
            self.pending_background = false;
            self.last_queued = Some(false);
        }
        if self.last_queued != Some(self.active)
            && sender
                .try_send(Command::Presence {
                    active: self.active,
                    revision: self.revision + 1,
                })
                .is_ok()
        {
            self.revision += 1;
            self.last_queued = Some(self.active);
        }
    }
}
#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
