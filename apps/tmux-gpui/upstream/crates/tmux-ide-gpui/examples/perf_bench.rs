//! Dev-only: main-thread frame cost and exact allocations per frame for fixed
//! scenarios, on the real window rendered offscreen (no display needed).
//! `cargo run --release -p tmux-ide-gpui --features visual-capture --example
//! perf_bench -- [frames] [scenario-filter]`. Compare builds by alternating
//! runs and give the load average with each. Not run by CI.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicU64, Ordering::Relaxed},
};

/// Counts every allocation and reallocation, then defers to the system.
struct Counting;
static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

// SAFETY: every method forwards its arguments unchanged to `System`, which
// upholds `GlobalAlloc`'s contract; the counters are plain atomics.
#[allow(unsafe_code)] // A counting allocator must implement the unsafe trait.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Relaxed);
        BYTES.fetch_add(layout.size() as u64, Relaxed);
        // SAFETY: the caller's contract for `alloc` is passed through.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: the caller's contract for `dealloc` is passed through.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Relaxed);
        BYTES.fetch_add(size as u64, Relaxed);
        // SAFETY: the caller's contract for `realloc` is passed through.
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[repr(C)]
struct Timespec {
    seconds: i64,
    nanoseconds: i64,
}
#[allow(unsafe_code)] // The thread's CPU clock has no std API.
unsafe extern "C" {
    fn clock_gettime(clock: u32, time: *mut Timespec) -> i32;
}
/// `CLOCK_THREAD_CPUTIME_ID` on macOS.
const THREAD_CPU: u32 = 16;

/// This thread's CPU time in nanoseconds: unlike the wall clock, it does not
/// count time the thread waits for a core, so it holds under load.
fn thread_cpu() -> u64 {
    let mut time = Timespec {
        seconds: 0,
        nanoseconds: 0,
    };
    // SAFETY: `time` is a valid, writable timespec for the call's duration.
    #[allow(unsafe_code)]
    let status = unsafe { clock_gettime(THREAD_CPU, &mut time) };
    if status != 0 {
        return 0;
    }
    (time.seconds as u64) * 1_000_000_000 + time.nanoseconds as u64
}

fn counts() -> (u64, u64, u64) {
    (ALLOCATIONS.load(Relaxed), BYTES.load(Relaxed), thread_cpu())
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let frames = args.next().and_then(|n| n.parse().ok()).unwrap_or(300);
    let filter = args.next();
    // main() runs on the main thread, which the macOS platform requires.
    tmux_ide_gpui::perf_bench(counts, frames, filter.as_deref())
}
