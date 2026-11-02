//! Catalog to terminal-loop events. A full queue is backpressure, never a reason
//! to close the catalog: events wait here in order, and consecutive catalog
//! snapshots collapse into the latest one.
use super::*;
use std::collections::VecDeque;

/// The receiver is gone: the terminal loop has exited, so the catalog must too.
pub(super) const EVENTS_CLOSED: &str = "native catalog event queue closed";
/// Discrete events a stalled terminal loop may owe before it counts as gone.
const MAX_BACKLOG: usize = 4096;

pub(super) struct Events {
    sender: mpsc::SyncSender<Incoming>,
    backlog: VecDeque<Incoming>,
}
impl From<mpsc::SyncSender<Incoming>> for Events {
    fn from(sender: mpsc::SyncSender<Incoming>) -> Self {
        Self {
            sender,
            backlog: VecDeque::new(),
        }
    }
}
impl Events {
    pub(super) fn emit(&mut self, event: Incoming) -> Result<(), Error> {
        // A snapshot is complete state; an unsent older one carries nothing newer.
        let coalesce = matches!(event, Incoming::Catalog(_))
            && matches!(self.backlog.back(), Some(Incoming::Catalog(_)));
        if coalesce && let Some(last) = self.backlog.back_mut() {
            *last = event;
        } else if self.backlog.len() >= MAX_BACKLOG {
            return Err(Error::Invalid(EVENTS_CLOSED));
        } else {
            self.backlog.push_back(event);
        }
        self.flush()
    }
    pub(super) fn flush(&mut self) -> Result<(), Error> {
        while let Some(event) = self.backlog.pop_front() {
            match self.sender.try_send(event) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(event)) => {
                    self.backlog.push_front(event);
                    return Ok(());
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.backlog.clear();
                    return Err(Error::Invalid(EVENTS_CLOSED));
                }
            }
        }
        Ok(())
    }
    pub(super) fn pending(&self) -> bool {
        !self.backlog.is_empty()
    }
}
pub(super) fn closed(error: &Error) -> bool {
    matches!(error, Error::Invalid(reason) if *reason == EVENTS_CLOSED)
}

#[cfg(test)]
#[path = "browser_native_local_outbox_tests.rs"]
mod tests;
