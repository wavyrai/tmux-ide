//! Handle borrowing follows browser/native.rs's existing HasWindowHandle route.
//! GPUI 0.3.6 macOS window.rs adds its Metal native_view to content_view; the raw
//! AppKit handle names that child. Glass is a sibling below it, never a child
//! above its Metal layer and never a replacement input responder.
use gpui::{Bounds, Pixels, Window};
use objc2::{MainThreadMarker, MainThreadOnly, rc::Retained};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSColor, NSGlassEffectView, NSGlassEffectViewStyle,
    NSView, NSWindowOrderingMode, NSWorkspace,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use wry::raw_window_handle::{HasWindowHandle, RawWindowHandle};

pub(super) struct Native {
    glass: Retained<NSGlassEffectView>,
    view: Retained<NSView>,
    parent: Retained<NSView>,
    surface: Option<u32>,
}
impl Drop for Native {
    fn drop(&mut self) {
        self.glass.removeFromSuperview();
    }
}
pub(super) fn has_native_handle(window: &Window) -> bool {
    HasWindowHandle::window_handle(window)
        .is_ok_and(|h| matches!(h.as_raw(), RawWindowHandle::AppKit(_)))
}
pub(super) fn sync(
    slot: &mut Option<Native>,
    window: &Window,
    bounds: Bounds<Pixels>,
    surface: u32,
) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    if surface > 0xffffff || !has_native_handle(window) {
        *slot = None;
        return false;
    }
    if !objc2::available!(macos = 26.0)
        || NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
        || NSWorkspace::sharedWorkspace().accessibilityDisplayShouldIncreaseContrast()
    {
        *slot = None;
        return false;
    }
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        *slot = None;
        return false;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        *slot = None;
        return false;
    };
    // SAFETY: GPUI's HasWindowHandle lends its live NSView for this call. This
    // runs on AppKit's main thread; retain it before storing beyond the borrow.
    // No cast to a GPUI-private subclass or ownership transfer is performed.
    #[allow(unsafe_code)] // Narrow raw-handle boundary; ownership rationale above.
    let view = unsafe { Retained::retain(handle.ns_view.as_ptr().cast::<NSView>()) };
    let Some(view) = view else {
        *slot = None;
        return false;
    };
    // SAFETY: the retained GPUI NSView is live and queried on AppKit's main
    // thread; retain the returned parent before storing the sibling relationship.
    #[allow(unsafe_code)]
    let parent = unsafe { view.superview() };
    let Some(parent) = parent else {
        *slot = None;
        return false;
    };
    let native_bounds = view.bounds();
    let Some([x, y, w, h]) = super::rect(
        f32::from(bounds.origin.x) as f64,
        f32::from(bounds.origin.y) as f64,
        f32::from(bounds.size.width) as f64,
        f32::from(bounds.size.height) as f64,
        native_bounds.size.width,
        native_bounds.size.height,
        view.isFlipped(),
    ) else {
        *slot = None;
        return false;
    };
    // Public NSView conversion preserves parent/window offsets and backing scale.
    let frame = view.convertRect_toView(
        NSRect::new(
            NSPoint::new(native_bounds.origin.x + x, native_bounds.origin.y + y),
            NSSize::new(w, h),
        ),
        Some(&parent),
    );
    if slot
        .as_ref()
        .is_some_and(|n| n.view != view || n.parent != parent)
    {
        *slot = None;
    }
    if slot.is_none() {
        let glass = NSGlassEffectView::initWithFrame(NSGlassEffectView::alloc(mtm), frame);
        glass.setStyle(NSGlassEffectViewStyle::Regular);
        glass.setCornerRadius(0.);
        parent.addSubview_positioned_relativeTo(&glass, NSWindowOrderingMode::Below, Some(&view));
        *slot = Some(Native {
            glass,
            view,
            parent,
            surface: None,
        });
    }
    if let Some(native) = slot {
        native.glass.setFrame(frame);
        if native.surface != Some(surface) {
            // Public immutable AppKit names; availability is checked before use.
            #[allow(unsafe_code)] // Read-only public framework constants.
            let name = unsafe {
                if crate::contrast::luminance(surface) > 0.5 {
                    objc2_app_kit::NSAppearanceNameAqua
                } else {
                    objc2_app_kit::NSAppearanceNameDarkAqua
                }
            };
            let appearance = NSAppearance::appearanceNamed(name);
            native.glass.setAppearance(appearance.as_deref());
            let channel = |shift: u32| ((surface >> shift) & 255u32) as f64 / 255.;
            native
                .glass
                .setTintColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(
                    channel(16),
                    channel(8),
                    channel(0),
                    1.,
                )));
            native.surface = Some(surface);
        }
    }
    true
}

// Notification delivery may be off-thread: the callback touches only an atomic
// flag. The existing view tick consumes it and requests the next UI redraw.
pub(super) struct Watcher {
    center: Retained<objc2_foundation::NSNotificationCenter>,
    token: Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
    dirty: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Watcher {
    pub fn new() -> Option<Self> {
        MainThreadMarker::new()?;
        let dirty = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = dirty.clone();
        let block = block2::RcBlock::new(
            move |_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
                flag.store(true, std::sync::atomic::Ordering::Release);
            },
        );
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: no object filter/queue, and the copied callback owns only a
        // Send+Sync atomic flag. Keep the exact returned registration for removal.
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
