//! Native pixel storage reservations. Transport authentication and native storage
//! import happen outside this module; reservations must precede allocation/import.
//! A lease follows the storage through scene and GPU ownership. Only its final
//! drop permits a retirement message, never merely receipt or CPU decode.
use crossbeam_channel::{Receiver, Sender, bounded};
#[cfg(test)]
#[path = "surface_lease_wake_tests.rs"]
mod wake_tests;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

pub const MAX_SURFACE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_OUTSTANDING_SURFACES: usize = 8;
pub const MAX_PROCESS_SURFACE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_PROCESS_SURFACES: usize = 32;

#[derive(Default)]
struct Budget {
    bytes: AtomicUsize,
    slots: AtomicUsize,
}
impl Budget {
    fn acquire(&self, bytes: usize) -> bool {
        if self
            .slots
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_PROCESS_SURFACES).then_some(n + 1)
            })
            .is_err()
        {
            return false;
        }
        if self
            .bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(bytes)
                    .filter(|total| *total <= MAX_PROCESS_SURFACE_BYTES)
            })
            .is_err()
        {
            self.slots.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        true
    }
    fn release(&self, bytes: usize) {
        self.bytes.fetch_sub(bytes, Ordering::AcqRel);
        self.slots.fetch_sub(1, Ordering::AcqRel);
    }
}
fn process_budget() -> Arc<Budget> {
    static BUDGET: OnceLock<Arc<Budget>> = OnceLock::new();
    Arc::clone(BUDGET.get_or_init(|| Arc::new(Budget::default())))
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("native surface owner is retired")]
    Retired,
    #[error("native surface storage bounds exceeded")]
    Bounds,
    #[error("native surface sequence is stale")]
    Sequence,
    #[error("native surface storage budget exhausted")]
    Full,
}

/// Exact storage charge, including row padding; packed BGRA, straight alpha.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub allocation_bytes: usize,
}
impl Layout {
    pub fn bytes(self) -> Result<usize, Error> {
        if self.width == 0 || self.height == 0 || self.width > 16384 || self.height > 16384 {
            return Err(Error::Bounds);
        }
        let row = self.width.checked_mul(4).ok_or(Error::Bounds)?;
        let bytes = self.stride.checked_mul(self.height).ok_or(Error::Bounds)?;
        if self.stride < row
            || !self.stride.is_multiple_of(4)
            || bytes > self.allocation_bytes
            || self.allocation_bytes > MAX_SURFACE_BYTES
        {
            return Err(Error::Bounds);
        }
        Ok(self.allocation_bytes)
    }
}

/// Scoped to this pool/connection. It must not be forwarded on a replacement socket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Retirement {
    pub sequence: u64,
}

/// Retain the same Arc with native backing storage until its final destruction.
/// Holding a separate UI-only copy is insufficient: GPU references must retain it.
pub struct Lease {
    budget: Arc<Budget>,
    bytes: usize,
    sequence: u64,
    retired: Arc<AtomicBool>,
    sender: Sender<Retirement>,
    wake: Option<Sender<()>>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        // Release the process charge only with final backing ownership, even if
        // the connection pool was retired/destroyed while the GPU was reading.
        self.budget.release(self.bytes);
        if !self.retired.load(Ordering::Acquire) {
            // There can be at most one event per outstanding reservation. The
            // queue has that exact capacity, so final drops never block a GPU
            // completion thread. Disconnect deliberately suppresses old ACKs.
            let _ = self.sender.try_send(Retirement {
                sequence: self.sequence,
            });
            if let Some(wake) = &self.wake {
                let _ = wake.try_send(());
            }
        }
    }
}

/// One authenticated connection's aggregate budget, across all its panes. A new
/// connection needs a fresh pool; never reset one while old leases are retained.
pub struct Pool {
    budget: Arc<Budget>,
    retired: Arc<AtomicBool>,
    sender: Sender<Retirement>,
    receiver: Receiver<Retirement>,
    outstanding: BTreeMap<u64, usize>,
    bytes: usize,
    last_sequence: u64,
    wake: Option<Sender<()>>,
}
impl Default for Pool {
    fn default() -> Self {
        Self::with_budget(process_budget())
    }
}
impl Pool {
    fn with_budget(budget: Arc<Budget>) -> Self {
        let (sender, receiver) = bounded(MAX_OUTSTANDING_SURFACES);
        Self {
            budget,
            retired: Arc::new(AtomicBool::new(false)),
            sender,
            receiver,
            outstanding: BTreeMap::new(),
            bytes: 0,
            last_sequence: 0,
            wake: None,
        }
    }
}
impl Pool {
    /// The wake queue carries no retirement data; the original pool remains the
    /// only consumer of ACKs. A full wake queue already guarantees a worker tick.
    pub fn set_waker(&mut self, wake: Sender<()>) {
        self.wake = Some(wake);
    }
    /// A rejected offer allocates nothing and does not consume its sequence.
    /// Caller must also verify pane incarnation/generation against its authority.
    pub fn reserve(&mut self, sequence: u64, layout: Layout) -> Result<Arc<Lease>, Error> {
        if self.retired.load(Ordering::Acquire) {
            return Err(Error::Retired);
        }
        if sequence <= self.last_sequence {
            return Err(Error::Sequence);
        }
        let bytes = layout.bytes()?;
        if self.outstanding.len() >= MAX_OUTSTANDING_SURFACES
            || bytes > MAX_SURFACE_BYTES.saturating_sub(self.bytes)
        {
            return Err(Error::Full);
        }
        if !self.budget.acquire(bytes) {
            return Err(Error::Full);
        }
        self.last_sequence = sequence;
        self.bytes += bytes;
        self.outstanding.insert(sequence, bytes);
        Ok(Arc::new(Lease {
            budget: Arc::clone(&self.budget),
            bytes,
            sequence,
            retired: Arc::clone(&self.retired),
            sender: self.sender.clone(),
            wake: self.wake.clone(),
        }))
    }
    /// Drain on the owning transport worker and send only on that connection.
    /// The producer cannot reuse storage until it receives this retirement.
    pub fn next_retirement(&mut self) -> Option<Retirement> {
        if self.retired.load(Ordering::Acquire) {
            return None;
        }
        let event = self.receiver.try_recv().ok()?;
        if let Some(bytes) = self.outstanding.remove(&event.sequence) {
            self.bytes -= bytes;
        }
        Some(event)
    }
    pub fn reserved_bytes(&self) -> usize {
        self.bytes
    }
    pub fn retire(&mut self) {
        self.retired.store(true, Ordering::Release);
        // Do not claim storage is freed: outstanding scene/GPU owners may still
        // exist. Keep the accounting until this old pool itself is destroyed.
        while self.receiver.try_recv().is_ok() {}
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        self.retire();
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    const SMALL: Layout = Layout {
        width: 16,
        height: 16,
        stride: 256,
        allocation_bytes: 4096,
    };
    #[test]
    fn final_consumer_not_first_drop_retires_storage() {
        let mut pool = Pool::with_budget(Arc::new(Budget::default()));
        let scene = pool.reserve(1, SMALL).unwrap();
        let gpu = Arc::clone(&scene);
        drop(scene);
        assert_eq!(pool.next_retirement(), None);
        assert_eq!(pool.reserved_bytes(), 4096);
        std::thread::spawn(move || drop(gpu)).join().unwrap();
        assert_eq!(pool.next_retirement(), Some(Retirement { sequence: 1 }));
        assert_eq!(pool.reserved_bytes(), 0);
        assert_eq!(pool.next_retirement(), None);
    }
    #[test]
    fn padded_bytes_and_slots_are_bounded_until_retirement_drains() {
        let mut pool = Pool::with_budget(Arc::new(Budget::default()));
        let leases: Vec<_> = (1..=8)
            .map(|seq| pool.reserve(seq, SMALL).unwrap())
            .collect();
        assert!(matches!(pool.reserve(9, SMALL), Err(Error::Full)));
        drop(leases);
        // No sender blocks, and not one of the eight final-drop events is lost.
        assert!(matches!(pool.reserve(9, SMALL), Err(Error::Full)));
        for seq in 1..=8 {
            assert_eq!(pool.next_retirement(), Some(Retirement { sequence: seq }));
        }
        assert_eq!(pool.reserved_bytes(), 0);
        assert!(pool.reserve(9, SMALL).is_ok());
    }
    #[test]
    fn byte_budget_precedes_import_and_rejects_overflow() {
        let mut pool = Pool::with_budget(Arc::new(Budget::default()));
        let full = Layout {
            width: 4096,
            height: 4096,
            stride: 16384,
            allocation_bytes: MAX_SURFACE_BYTES,
        };
        let lease = pool.reserve(1, full).unwrap();
        assert!(matches!(pool.reserve(2, SMALL), Err(Error::Full)));
        assert_eq!(pool.reserved_bytes(), MAX_SURFACE_BYTES);
        for layout in [
            Layout {
                stride: usize::MAX,
                ..SMALL
            },
            Layout { height: 0, ..SMALL },
            Layout {
                stride: 12,
                ..SMALL
            },
        ] {
            assert_eq!(layout.bytes(), Err(Error::Bounds));
        }
        drop(lease);
        assert!(pool.next_retirement().is_some());
        assert!(pool.reserve(2, SMALL).is_ok());
    }
    #[test]
    fn retired_connection_never_emits_ack_on_replacement() {
        let mut old = Pool::default();
        let lease = old.reserve(1, SMALL).unwrap();
        old.retire();
        drop(lease);
        assert_eq!(old.next_retirement(), None);
        assert!(matches!(old.reserve(2, SMALL), Err(Error::Retired)));
        let mut new = Pool::default();
        assert_eq!(new.next_retirement(), None);
        assert!(new.reserve(1, SMALL).is_ok());
    }
    #[test]
    fn late_out_of_order_gpu_completion_does_not_allow_sequence_replay() {
        let mut pool = Pool::with_budget(Arc::new(Budget::default()));
        let first = pool.reserve(1, SMALL).unwrap();
        let second = pool.reserve(2, SMALL).unwrap();
        drop(second);
        assert_eq!(pool.next_retirement(), Some(Retirement { sequence: 2 }));
        assert!(matches!(pool.reserve(1, SMALL), Err(Error::Sequence)));
        drop(first);
        assert_eq!(pool.next_retirement(), Some(Retirement { sequence: 1 }));
        assert!(matches!(pool.reserve(2, SMALL), Err(Error::Sequence)));
    }
    #[test]
    fn old_connection_storage_remains_charged_across_reconnects() {
        let budget = Arc::new(Budget::default());
        let full = Layout {
            width: 4096,
            height: 4096,
            stride: 16384,
            allocation_bytes: MAX_SURFACE_BYTES,
        };
        let mut retained = Vec::new();
        for _ in 0..4 {
            let mut old = Pool::with_budget(Arc::clone(&budget));
            retained.push(old.reserve(1, full).unwrap());
            drop(old);
        }
        let mut replacement = Pool::with_budget(Arc::clone(&budget));
        assert!(matches!(replacement.reserve(1, SMALL), Err(Error::Full)));
        assert_eq!(
            budget.bytes.load(Ordering::Acquire),
            MAX_PROCESS_SURFACE_BYTES
        );
        // A failed byte reservation must return its tentative slot charge.
        assert_eq!(budget.slots.load(Ordering::Acquire), 4);
        drop(retained.pop());
        assert!(replacement.reserve(1, SMALL).is_ok());
        drop(retained);
        assert_eq!(budget.bytes.load(Ordering::Acquire), 0);
        assert_eq!(budget.slots.load(Ordering::Acquire), 0);
    }
    #[test]
    fn aggregate_slot_limit_covers_small_frames_from_many_connections() {
        let budget = Arc::new(Budget::default());
        let mut retained = Vec::new();
        for _ in 0..MAX_PROCESS_SURFACES {
            let mut pool = Pool::with_budget(Arc::clone(&budget));
            retained.push(pool.reserve(1, SMALL).unwrap());
        }
        let mut pool = Pool::with_budget(Arc::clone(&budget));
        assert!(matches!(pool.reserve(1, SMALL), Err(Error::Full)));
        drop(retained);
        assert!(pool.reserve(1, SMALL).is_ok());
    }
    #[test]
    fn concurrent_admission_never_overcommits_and_returns_all_charges() {
        let budget = Arc::new(Budget::default());
        let barrier = Arc::new(std::sync::Barrier::new(17));
        let admitted = Arc::new(AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..16 {
                let budget = Arc::clone(&budget);
                let barrier = Arc::clone(&barrier);
                let admitted = Arc::clone(&admitted);
                scope.spawn(move || {
                    let accepted = budget.acquire(MAX_SURFACE_BYTES);
                    if accepted {
                        admitted.fetch_add(1, Ordering::AcqRel);
                    }
                    barrier.wait();
                    barrier.wait();
                    if accepted {
                        budget.release(MAX_SURFACE_BYTES);
                    }
                });
            }
            barrier.wait();
            let count = admitted.load(Ordering::Acquire);
            let bytes = budget.bytes.load(Ordering::Acquire);
            let slots = budget.slots.load(Ordering::Acquire);
            // Release workers before assertions so a failing assertion cannot
            // strand scoped threads at the second barrier.
            barrier.wait();
            assert_eq!(count, 4);
            assert_eq!(bytes, MAX_PROCESS_SURFACE_BYTES);
            assert_eq!(slots, 4);
        });
        assert_eq!(budget.bytes.load(Ordering::Acquire), 0);
        assert_eq!(budget.slots.load(Ordering::Acquire), 0);
        assert!(Arc::ptr_eq(
            &Pool::default().budget,
            &Pool::default().budget
        ));
    }
    #[test]
    fn platform_allocation_padding_is_charged_and_cannot_understate_rows() {
        let mut pool = Pool::with_budget(Arc::new(Budget::default()));
        let layout = Layout {
            allocation_bytes: 16384,
            ..SMALL
        };
        let lease = pool.reserve(1, layout).unwrap();
        assert_eq!(pool.reserved_bytes(), 16384);
        assert_eq!(
            Layout {
                allocation_bytes: 1024,
                ..SMALL
            }
            .bytes(),
            Err(Error::Bounds)
        );
        assert_eq!(
            Layout {
                allocation_bytes: MAX_SURFACE_BYTES + 1,
                ..SMALL
            }
            .bytes(),
            Err(Error::Bounds)
        );
        drop(lease);
        assert!(pool.next_retirement().is_some());
        assert_eq!(pool.reserved_bytes(), 0);
    }
}
