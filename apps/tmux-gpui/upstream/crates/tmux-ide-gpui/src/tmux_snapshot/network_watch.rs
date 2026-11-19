//! The Mac woke, or its network changed (reconnect, 19 Nov 2026). Either can
//! leave a stream on a link that died without closing, and either is the
//! moment a reconnect that waits out its backoff should try again.
//!
//! - Every open pane stream is probed at once
//!   (`herdr_client::tmux_stream::probe_all`): a dead link is found within
//!   the stream's pong limit (5 s), and keys typed meanwhile are held.
//! - When the network is usable again (and on wake), the epoch moves on. A
//!   catalog recovery that is waiting reads it on its next tick and tries now
//!   (`browser_native_local_reconnect.rs`).
//!
//! Sources: `NSWorkspaceDidWakeNotification`, and Network.framework's path
//! monitor through its C API. Both callbacks touch only atomics and the
//! stream registry.
use std::sync::atomic::{AtomicU64, Ordering};

static EPOCH: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
thread_local! {
    /// Tests run side by side: each thread has its own wakes.
    static TEST_EPOCH: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Moves on each time the Mac wakes or the network becomes usable again.
pub(in crate::tmux_snapshot) fn epoch() -> u64 {
    #[cfg(test)]
    return TEST_EPOCH.with(std::cell::Cell::get);
    #[cfg(not(test))]
    EPOCH.load(Ordering::Acquire)
}

/// The Mac woke, or the network is usable again: probe every stream and let
/// a waiting recovery try now.
#[cfg_attr(test, allow(dead_code))]
pub(super) fn usable_again() {
    EPOCH.fetch_add(1, Ordering::AcqRel);
    herdr_client::tmux_stream::probe_all();
}

/// The network changed, but is not usable: probe the streams, which then end
/// within the pong limit if their link went with it.
#[cfg_attr(test, allow(dead_code))]
fn changed() {
    herdr_client::tmux_stream::probe_all();
}

/// Starts watching, once per process, on the main thread.
pub(in crate::tmux_snapshot) fn start() {
    #[cfg(all(target_os = "macos", not(test)))]
    {
        static STARTED: std::sync::Once = std::sync::Once::new();
        STARTED.call_once(macos::start);
    }
}

#[cfg(all(target_os = "macos", not(test)))]
mod macos {
    use objc2_app_kit::NSWorkspace;
    use std::{
        ffi::c_void,
        sync::atomic::{AtomicU32, Ordering},
    };

    /// `nw_path_status_satisfied`.
    const SATISFIED: i32 = 1;

    #[allow(unsafe_code)] // Network.framework C API, called only in `path` below.
    #[link(name = "Network", kind = "framework")]
    unsafe extern "C" {
        fn nw_path_monitor_create() -> *mut c_void;
        fn nw_path_monitor_set_update_handler(
            monitor: *mut c_void,
            handler: &block2::Block<dyn Fn(*mut c_void)>,
        );
        fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: *mut c_void);
        fn nw_path_monitor_start(monitor: *mut c_void);
        fn nw_path_get_status(path: *mut c_void) -> i32;
    }
    #[allow(unsafe_code)] // libdispatch, called only in `path` below.
    unsafe extern "C" {
        fn dispatch_queue_create(label: *const std::ffi::c_char, attr: *mut c_void) -> *mut c_void;
    }

    pub(super) fn start() {
        wake();
        path();
    }

    /// `NSWorkspaceDidWakeNotification`. The observer lives as long as the
    /// process: it is never removed.
    fn wake() {
        let block =
            block2::RcBlock::new(|_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
                super::usable_again();
            });
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: no object filter or queue; the callback captures nothing
        // and touches only atomics and the stream registry.
        #[allow(unsafe_code)] // One process-lifetime observer; rationale above.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(objc2_app_kit::NSWorkspaceDidWakeNotification),
                None,
                None,
                &block,
            )
        };
        std::mem::forget(token);
    }

    /// Network.framework's path monitor, on a private serial queue. Its first
    /// update reports the path as it is at start: only later ones are news.
    fn path() {
        // 0: no update yet; then the last status + 1.
        static LAST: AtomicU32 = AtomicU32::new(0);
        let handler = block2::RcBlock::new(|path: *mut c_void| {
            // SAFETY: the monitor passes a valid path for the call's duration.
            #[allow(unsafe_code)] // Read-only status of the path we were handed.
            let status = unsafe { nw_path_get_status(path) };
            let last = LAST.swap(status.unsigned_abs() + 1, Ordering::AcqRel);
            if last == 0 {
                return;
            }
            if status == SATISFIED {
                super::usable_again();
            } else {
                super::changed();
            }
        });
        // SAFETY: the monitor and its queue are created here and kept for the
        // life of the process; the handler block is copied by the monitor.
        #[allow(unsafe_code)] // Network.framework C API; rationale above.
        unsafe {
            let monitor = nw_path_monitor_create();
            if monitor.is_null() {
                return;
            }
            let queue =
                dispatch_queue_create(c"com.tmux-ide.network-watch".as_ptr(), std::ptr::null_mut());
            if queue.is_null() {
                return;
            }
            nw_path_monitor_set_update_handler(monitor, &handler);
            nw_path_monitor_set_queue(monitor, queue);
            nw_path_monitor_start(monitor);
        }
    }
}

/// Tests stand in for a wake, on their own thread only.
#[cfg(test)]
pub(in crate::tmux_snapshot) fn simulate_wake() {
    TEST_EPOCH.with(|epoch| epoch.set(epoch.get() + 1));
}
