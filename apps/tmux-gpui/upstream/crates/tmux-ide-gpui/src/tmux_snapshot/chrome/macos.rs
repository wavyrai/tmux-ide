//! The accessibility settings that rule out translucent chrome, and a watcher
//! that marks the view dirty when they change.
use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::NSWorkspace;

/// macOS "Reduce motion" (#761). Tests stand in for it.
#[cfg_attr(test, allow(dead_code))]
pub(super) fn motion_reduced() -> bool {
    NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
}

pub(super) fn translucency_allowed() -> bool {
    let workspace = NSWorkspace::sharedWorkspace();
    !workspace.accessibilityDisplayShouldReduceTransparency()
        && !workspace.accessibilityDisplayShouldIncreaseContrast()
}

// Notification delivery may be off-thread: the callback touches only an atomic
// flag and the UI task's wake. The view tick consumes the flag and redraws.
/// Set once the window's UI task runs; called after each change.
pub(super) type Wake = std::sync::Arc<std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>>;

pub(super) struct Watcher {
    center: Retained<objc2_foundation::NSNotificationCenter>,
    token: Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
    dirty: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Watcher {
    pub fn new(wake: Wake) -> Option<Self> {
        MainThreadMarker::new()?;
        let dirty = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = dirty.clone();
        let block = block2::RcBlock::new(
            move |_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
                flag.store(true, std::sync::atomic::Ordering::Release);
                if let Some(wake) = wake.get() {
                    wake();
                }
            },
        );
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: no object filter/queue, and the copied callback owns only
        // a Send+Sync atomic flag and wake. Keep the exact returned registration for removal.
        #[allow(unsafe_code)] // Exact registration; sendable callback rationale above.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(objc2_app_kit::NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
                None,
                None,
                &block,
            )
        };
        Some(Self {
            center,
            token,
            dirty,
        })
    }
    pub fn take(&self) -> bool {
        self.dirty.swap(false, std::sync::atomic::Ordering::AcqRel)
    }
}
impl Drop for Watcher {
    fn drop(&mut self) {
        // SAFETY: token is precisely the registration returned by this center.
        #[allow(unsafe_code)] // Unregister only our retained observer token.
        unsafe {
            let observer: &objc2::runtime::AnyObject = (*self.token).as_ref();
            self.center.removeObserver(observer);
        }
    }
}
