//! The latest browser publication, handed from the transport thread to the UI.
//! A publication wakes the UI task at once instead of waiting for its 16 ms
//! tick (#710); the tick stays for queued UI work only.
use super::State;
use std::{
    future::Future,
    ops::{Deref, DerefMut},
    pin::{Pin, pin},
    sync::{
        Mutex, MutexGuard, PoisonError, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
};

type Slot = Option<Option<State>>;

#[derive(Default)]
pub(in crate::tmux_snapshot) struct MailboxSlot {
    slot: Mutex<Slot>,
    published: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

/// Holds the slot; when dropped holding a publication, it unlocks first and
/// then wakes the UI, so the woken task never finds the slot still locked.
pub(in crate::tmux_snapshot) struct MailboxGuard<'a> {
    guard: Option<MutexGuard<'a, Slot>>,
    mailbox: &'a MailboxSlot,
}

impl MailboxSlot {
    pub(in crate::tmux_snapshot) fn lock(&self) -> Result<MailboxGuard<'_>, PoisonError<()>> {
        let guard = self.slot.lock().map_err(|_| PoisonError::new(()))?;
        Ok(self.guard(guard))
    }
    pub(in crate::tmux_snapshot) fn try_lock(&self) -> Result<MailboxGuard<'_>, TryLockError<()>> {
        let guard = self.slot.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => TryLockError::WouldBlock,
            TryLockError::Poisoned(_) => TryLockError::Poisoned(PoisonError::new(())),
        })?;
        Ok(self.guard(guard))
    }
    fn guard<'a>(&'a self, guard: MutexGuard<'a, Slot>) -> MailboxGuard<'a> {
        MailboxGuard {
            guard: Some(guard),
            mailbox: self,
        }
    }
    /// Sets the flag before waking, so the woken task's poll sees it.
    fn wake(&self) {
        self.published.store(true, Ordering::Release);
        let waker = self.waker.lock().ok().and_then(|mut waker| waker.take());
        if let Some(waker) = waker {
            waker.wake();
        }
    }
    /// Resolves once a publication has arrived since the last time it resolved.
    pub(in crate::tmux_snapshot) fn published(&self) -> Published<'_> {
        Published { mailbox: self }
    }
}

impl Deref for MailboxGuard<'_> {
    type Target = Slot;
    fn deref(&self) -> &Slot {
        self.guard.as_deref().unwrap_or(&None)
    }
}
impl DerefMut for MailboxGuard<'_> {
    fn deref_mut(&mut self) -> &mut Slot {
        // `guard` is only taken in `drop`.
        self.guard.as_deref_mut().unwrap_or_else(|| unreachable!())
    }
}
impl Drop for MailboxGuard<'_> {
    fn drop(&mut self) {
        let filled = self.guard.as_deref().is_some_and(Option::is_some);
        self.guard = None;
        if filled {
            self.mailbox.wake();
        }
    }
}

pub(in crate::tmux_snapshot) struct Published<'a> {
    mailbox: &'a MailboxSlot,
}
impl Future for Published<'_> {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mailbox = self.mailbox;
        if mailbox.published.swap(false, Ordering::AcqRel) {
            return Poll::Ready(());
        }
        #[cfg(test)]
        tests::between_check_and_store();
        if let Ok(mut waker) = mailbox.waker.lock() {
            *waker = Some(cx.waker().clone());
        }
        // A publication between the first check and storing the waker found
        // no waker to wake; only this second check sees it.
        if mailbox.published.swap(false, Ordering::AcqRel) {
            return Poll::Ready(());
        }
        Poll::Pending
    }
}

/// Wait for the UI tick or a new publication, whichever comes first.
pub(in crate::tmux_snapshot) async fn tick_or_publication(
    tick: impl Future<Output = ()>,
    mailbox: &MailboxSlot,
) {
    let mut tick = pin!(tick);
    let mut published = pin!(mailbox.published());
    std::future::poll_fn(|cx| {
        if tick.as_mut().poll(cx).is_ready() || published.as_mut().poll(cx).is_ready() {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await
}

#[cfg(test)]
#[path = "browser_mailbox_tests.rs"]
mod tests;
