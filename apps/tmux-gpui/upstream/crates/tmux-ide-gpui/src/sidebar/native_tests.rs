//! Exact-window, main-thread-only AppKit events for the isolated fixture.
#![allow(unsafe_code, deprecated, unexpected_cfgs)]
use anyhow::{Context as _, Result, bail};
use cocoa::{
    base::{id, nil},
    foundation::{NSPoint, NSRect},
};
use core_graphics::{
    event::{CGEvent, CGEventType, CGMouseButton},
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::CGPoint,
};
use foreign_types::ForeignType;
use objc::{class, msg_send, sel, sel_impl};
use std::{marker::PhantomData, rc::Rc};

// raw-window-handle does not implement Error without its optional std feature.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct NativeHandleError(raw_window_handle::HandleError);

#[derive(Debug)]
pub(crate) struct Target {
    view: id,
    window: id,
    _main_thread: PhantomData<Rc<()>>,
}

impl Target {
    pub(crate) fn acquire(window: &gpui::Window) -> Result<Self> {
        let handle = raw_window_handle::HasWindowHandle::window_handle(window)
            .map_err(NativeHandleError)
            .context("acquiring native fixture window handle")?;
        let raw_window_handle::RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            bail!("fixture is not AppKit");
        };
        // GPUI supplies this live view on the UI thread. Retain both objects only
        // across the update boundary: native callbacks reenter GPUI there.
        unsafe {
            let main: bool = msg_send![class!(NSThread), isMainThread];
            if !main {
                bail!("native fixture target requires main thread");
            }
            let view = handle.ns_view.as_ptr().cast();
            let window: id = msg_send![view, window];
            if window == nil {
                bail!("fixture view has no window");
            }
            let _: id = msg_send![view, retain];
            let _: id = msg_send![window, retain];
            Ok(Self {
                view,
                window,
                _main_thread: PhantomData,
            })
        }
    }

    pub(crate) fn is_key(&self) -> bool {
        unsafe { msg_send![self.window, isKeyWindow] }
    }

    pub(crate) fn paste(&self) -> Result<()> {
        let characters = objc2_foundation::NSString::from_str("v");
        let characters = (&*characters as *const objc2_foundation::NSString)
            .cast_mut()
            .cast::<objc::runtime::Object>();
        // GPUI exposes no safe native event-injection API. These retained AppKit
        // objects are main-thread-only and live across this callback; dispatch
        // outside an App update so the native key equivalent can reenter GPUI.
        unsafe {
            let number: isize = msg_send![self.window, windowNumber];
            let event: id = msg_send![class!(NSEvent), keyEventWithType: 10_usize
                location: NSPoint::new(0., 0.) modifierFlags: (1_usize << 20)
                timestamp: 0_f64 windowNumber: number context: nil
                characters: characters charactersIgnoringModifiers: characters
                isARepeat: false keyCode: 9_u16];
            if event == nil {
                bail!("cannot create native Cmd-V event");
            }
            let handled: bool = msg_send![self.window, performKeyEquivalent: event];
            if !handled {
                let _: () = msg_send![self.window, sendEvent: event];
            }
        }
        Ok(())
    }

    pub(crate) fn click(&self, x: f64, y: f64) -> Result<()> {
        self.pointer_events(&[(1, x, y), (2, x, y)])
    }

    pub(crate) fn drag(&self, from: (f64, f64), to: (f64, f64)) -> Result<()> {
        self.pointer_events(&[(1, from.0, from.1), (6, to.0, to.1), (2, to.0, to.1)])
    }

    fn pointer_events(&self, events: &[(usize, f64, f64)]) -> Result<()> {
        // The retained view/window belong to this UI-thread fixture. Dispatch
        // outside GPUI updates because AppKit callbacks reenter the window.
        unsafe {
            let bounds: NSRect = msg_send![self.view, bounds];
            let flipped: bool = msg_send![self.view, isFlipped];
            let number: isize = msg_send![self.window, windowNumber];
            for &(kind, x, y) in events {
                let point = NSPoint::new(
                    bounds.origin.x + x,
                    bounds.origin.y + if flipped { y } else { bounds.size.height - y },
                );
                let location: NSPoint = msg_send![self.view, convertPoint: point toView: nil];
                let event: id = msg_send![class!(NSEvent), mouseEventWithType: kind
                    location: location modifierFlags: 0_usize timestamp: 0_f64
                    windowNumber: number context: nil eventNumber: 0_isize
                    clickCount: 1_isize pressure: 1_f32];
                if event == nil {
                    bail!("cannot create fixture pointer event");
                }
                if kind == 1 {
                    let _: () = msg_send![self.view, mouseDown: event];
                } else if kind == 6 {
                    let _: () = msg_send![self.view, mouseDragged: event];
                } else {
                    let _: () = msg_send![self.view, mouseUp: event];
                }
            }
        }
        Ok(())
    }

    pub(crate) fn right_click(&self, x: f64, y: f64) -> Result<()> {
        // CGEvent supplies the right-button number that mouseEventWithType omits.
        // Dispatch directly to the retained fixture view, never the key window.
        unsafe {
            let bounds: NSRect = msg_send![self.view, bounds];
            let flipped: bool = msg_send![self.view, isFlipped];
            let point = NSPoint::new(
                bounds.origin.x + x,
                bounds.origin.y + if flipped { y } else { bounds.size.height - y },
            );
            let location: NSPoint = msg_send![self.view, convertPoint: point toView: nil];
            let screens: id = msg_send![class!(NSScreen), screens];
            let screen: id = msg_send![screens, objectAtIndex: 0_usize];
            let frame: NSRect = msg_send![screen, frame];
            for kind in [CGEventType::RightMouseDown, CGEventType::RightMouseUp] {
                let source = CGEventSource::new(CGEventSourceStateID::Private)
                    .map_err(|_| anyhow::anyhow!("event source"))?;
                let event = CGEvent::new_mouse_event(
                    source,
                    kind,
                    CGPoint::new(location.x, frame.size.height - location.y),
                    CGMouseButton::Right,
                )
                .map_err(|_| anyhow::anyhow!("right mouse event"))?;
                let native: id = msg_send![class!(NSEvent), eventWithCGEvent: event.as_ptr()];
                if native == nil {
                    bail!("cannot create native right mouse event");
                }
                if matches!(kind, CGEventType::RightMouseDown) {
                    let _: () = msg_send![self.view, rightMouseDown: native];
                } else {
                    let _: () = msg_send![self.view, rightMouseUp: native];
                }
            }
        }
        Ok(())
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![self.view, release];
            let _: () = msg_send![self.window, release];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::NativeHandleError;
    use anyhow::Context as _;

    #[test]
    fn native_handle_error_retains_typed_cause() -> anyhow::Result<()> {
        let error = Err::<(), _>(NativeHandleError(
            raw_window_handle::HandleError::Unavailable,
        ))
        .context("acquiring native fixture window handle")
        .err()
        .context("fixture unexpectedly succeeded")?;
        let cause = error
            .downcast_ref::<NativeHandleError>()
            .context("missing typed native handle error")?;
        assert!(matches!(
            cause.0,
            raw_window_handle::HandleError::Unavailable
        ));
        assert_eq!(error.chain().count(), 2);
        Ok(())
    }
}
