//! Optional platform owner driven by the existing authenticated model worker.
//! No GPUI types, image payload queues, or UI-thread polling belong here.
use super::{CommittedPane, Error};
use crate::tmux_stream::PaneStream;
use std::{collections::BTreeMap, sync::Arc, time::Instant};

pub type Failure = Box<dyn std::error::Error + Send + Sync>;
pub type Committed = BTreeMap<String, Arc<CommittedPane>>;
pub type WakeSender = crossbeam_channel::Sender<()>;

/// Implementations own one connection's native endpoints and bounded image
/// mailbox. Every method runs on its model worker, must be nonblocking, and must
/// preserve existing stream write bounds. Errors retain their typed source.
pub trait Driver: Send {
    fn set_waker(&mut self, _wake: WakeSender) {}
    /// Invoked exactly once, after authenticated stream readiness. Do not create
    /// endpoints or send native control before this method runs.
    fn start(&mut self, stream: &PaneStream) -> Result<(), Failure>;
    fn accept(
        &mut self,
        raw: &str,
        committed: &Committed,
        stream: &PaneStream,
    ) -> Result<(), Failure>;
    fn poll(
        &mut self,
        now: Instant,
        committed: &Committed,
        stream: &PaneStream,
    ) -> Result<(), Failure>;
    /// None disarms maintenance. Deadlines must advance after a due poll, avoiding
    /// a busy loop while waiting for proof, storage or GPU retirement.
    fn deadline(&self) -> Option<Instant>;
    /// Revoke endpoints and suppress late ACKs. Imported backing may remain alive
    /// in the renderer. This must not join a thread or wait for GPU completion.
    fn close(&mut self);
}

pub(super) struct Owner {
    driver: Box<dyn Driver>,
    started: bool,
    wake: WakeSender,
    events: crossbeam_channel::Receiver<()>,
}
impl Owner {
    pub fn new(driver: Box<dyn Driver>) -> Self {
        let (wake, events) = crossbeam_channel::bounded(1);
        Self {
            driver,
            started: false,
            wake,
            events,
        }
    }
    pub fn start(&mut self, stream: &PaneStream) -> Result<(), Error> {
        if self.started {
            return Err(Error::GraphicsDisabled);
        }
        self.driver.set_waker(self.wake.clone());
        self.driver.start(stream).map_err(Error::NativeSurface)?;
        self.started = true;
        Ok(())
    }
    pub fn accept(
        &mut self,
        raw: &str,
        committed: &Committed,
        stream: &PaneStream,
    ) -> Result<(), Error> {
        if !self.started {
            return Err(Error::GraphicsDisabled);
        }
        self.driver
            .accept(raw, committed, stream)
            .map_err(Error::NativeSurface)
    }
    pub fn poll(
        &mut self,
        now: Instant,
        committed: &Committed,
        stream: &PaneStream,
    ) -> Result<(), Error> {
        if self.deadline().is_some_and(|deadline| deadline <= now) {
            self.driver
                .poll(now, committed, stream)
                .map_err(Error::NativeSurface)?;
        }
        Ok(())
    }
    pub fn deadline(&self) -> Option<Instant> {
        self.started.then(|| self.driver.deadline()).flatten()
    }
    pub fn events(&self) -> crossbeam_channel::Receiver<()> {
        self.events.clone()
    }
    pub fn wake(&mut self, committed: &Committed, stream: &PaneStream) -> Result<(), Error> {
        if self.started {
            self.driver
                .poll(Instant::now(), committed, stream)
                .map_err(Error::NativeSurface)?;
        }
        Ok(())
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        self.driver.close();
    }
}
