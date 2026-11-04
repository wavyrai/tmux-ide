#![allow(clippy::unwrap_used)]
use super::*;
use std::cell::RefCell;
use std::sync::{Arc, atomic::AtomicUsize};
use std::task::Wake;

thread_local! {
    static BETWEEN: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
}
/// Test hook in `Published::poll`, after the first check and before the waker is stored.
pub(super) fn between_check_and_store() {
    if let Some(hook) = BETWEEN.with_borrow_mut(Option::take) {
        hook();
    }
}

/// Records, at the moment it is woken, whether the slot is unlocked and the
/// publication flag already set: the two orderings the wake relies on.
struct Inspect {
    mailbox: Arc<MailboxSlot>,
    seen: Mutex<Option<(bool, bool)>>,
}
impl Wake for Inspect {
    fn wake(self: Arc<Self>) {
        // Read the flag first, and probe the raw slot so the probe cannot wake.
        let published = self.mailbox.published.load(Ordering::SeqCst);
        let unlocked = self.mailbox.slot.try_lock().is_ok();
        *self.seen.lock().unwrap() = Some((unlocked, published));
    }
}

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
    // The publication is there to take. The wake ordering itself is pinned by
    // `the_ui_is_woken_after_the_slot_unlocks_and_the_flag_is_set`.
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

#[test]
fn the_ui_is_woken_after_the_slot_unlocks_and_the_flag_is_set() {
    let mailbox = Arc::new(MailboxSlot::default());
    let inspect = Arc::new(Inspect {
        mailbox: mailbox.clone(),
        seen: Mutex::new(None),
    });
    let waker = Waker::from(inspect.clone());
    let mut published = pin!(mailbox.published());
    assert!(
        published
            .as_mut()
            .poll(&mut Context::from_waker(&waker))
            .is_pending()
    );
    *mailbox.lock().unwrap() = Some(Some(State::default()));
    // (unlocked, published): a woken UI must find the slot free and the flag set,
    // or it would wait for the next 16 ms tick.
    assert_eq!(*inspect.seen.lock().unwrap(), Some((true, true)));
}

#[test]
fn a_publication_between_the_check_and_storing_the_waker_is_not_missed() {
    let mailbox = Arc::new(MailboxSlot::default());
    let producer = mailbox.clone();
    BETWEEN.with_borrow_mut(|hook| {
        *hook = Some(Box::new(move || {
            *producer.lock().unwrap() = Some(Some(State::default()));
        }));
    });
    let count = Arc::new(Count(AtomicUsize::new(0)));
    let mut published = pin!(mailbox.published());
    // The publication finds no waker yet; the re-check after storing it must see the flag.
    assert!(poll(published.as_mut(), &count).is_ready());
}
