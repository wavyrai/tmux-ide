#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn final_drop_coalesces_wakes_without_consuming_retirements() {
    let mut pool = Pool::with_budget(Arc::new(Budget::default()));
    let (wake, events) = bounded(1);
    pool.set_waker(wake);
    let layout = Layout {
        width: 1,
        height: 1,
        stride: 4,
        allocation_bytes: 4,
    };
    let first = pool.reserve(1, layout).unwrap();
    let retained = Arc::clone(&first);
    let second = pool.reserve(2, layout).unwrap();
    drop(first);
    assert!(events.try_recv().is_err());
    drop(retained);
    drop(second); // A full notification queue must never block final/GPU drop.
    assert_eq!(events.len(), 1);
    events.try_recv().unwrap();
    assert_eq!(pool.next_retirement(), Some(Retirement { sequence: 1 }));
    assert_eq!(pool.next_retirement(), Some(Retirement { sequence: 2 }));
    assert_eq!(pool.next_retirement(), None);
    let third = pool.reserve(3, layout).unwrap();
    pool.retire();
    drop(third);
    assert!(events.try_recv().is_err());
}
