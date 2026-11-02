#![allow(clippy::unwrap_used)]
use super::*;
use std::sync::{Arc, atomic::AtomicUsize};
use std::task::Wake;

struct Count(AtomicUsize);
impl Wake for Count {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn poll(future: Pin<&mut impl Future<Output = ()>>, count: &Arc<Count>) -> Poll<()> {
    let waker = Waker::from(count.clone());
    future.poll(&mut Context::from_waker(&waker))
}

#[test]
fn a_publication_from_another_thread_wakes_the_waiting_ui() {
    let mailbox = Arc::new(MailboxSlot::default());
    let count = Arc::new(Count(AtomicUsize::new(0)));
    let mut published = pin!(mailbox.published());
    assert!(poll(published.as_mut(), &count).is_pending());
    let producer = mailbox.clone();
    std::thread::spawn(move || {
        *producer.lock().unwrap() = Some(Some(State::default()));
    })
    .join()
    .unwrap();
    assert_eq!(
        count.0.load(Ordering::SeqCst),
        1,
        "the UI task was not woken"
    );
    assert!(poll(published.as_mut(), &count).is_ready());
    // Woken after the guard unlocked: the UI's try_lock always succeeds.
    assert!(mailbox.try_lock().unwrap().take().is_some());
}

#[test]
fn taking_the_publication_does_not_wake_anyone() {
    let mailbox = MailboxSlot::default();
    *mailbox.lock().unwrap() = Some(None);
    let count = Arc::new(Count(AtomicUsize::new(0)));
    let mut published = pin!(mailbox.published());
    assert!(poll(published.as_mut(), &count).is_ready());
    assert!(mailbox.try_lock().unwrap().take().is_some());
    let mut again = pin!(mailbox.published());
    assert!(poll(again.as_mut(), &count).is_pending());
    assert_eq!(count.0.load(Ordering::SeqCst), 0);
}

#[test]
fn a_publication_before_the_ui_waits_is_not_lost() {
    let mailbox = MailboxSlot::default();
    *mailbox.lock().unwrap() = Some(Some(State::default()));
    let count = Arc::new(Count(AtomicUsize::new(0)));
    let mut published = pin!(mailbox.published());
    assert!(poll(published.as_mut(), &count).is_ready());
}

#[test]
fn the_tick_still_fires_without_a_publication() {
    let mailbox = MailboxSlot::default();
    let count = Arc::new(Count(AtomicUsize::new(0)));
    let mut wait = pin!(tick_or_publication(std::future::ready(()), &mailbox));
    assert!(poll(wait.as_mut(), &count).is_ready());
}
