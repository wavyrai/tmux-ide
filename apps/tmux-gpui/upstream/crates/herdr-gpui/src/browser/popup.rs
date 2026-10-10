//! Pages a page opens itself, with `window.open` or a link to a new window.
//!
//! WebKit links a popup to its opener only when the opener's request is
//! answered with a web view built, there and then, from the configuration
//! WebKit passes. Sign-in flows depend on that link: the popup reports back
//! through `window.opener` and then calls `window.close()`. So the popup is
//! built here while WebKit waits, and the window adopts it as a tab on its
//! next tick.
//!
//! Two steps need `unsafe`, as neither wry nor `objc2` offers a safe form:
//! - wry builds a view only as a child of a window handle, and the one at hand
//!   while WebKit waits is the opener's parent `NSView`, so a handle is
//!   borrowed from it.
//! - `window.close()` reaches the app only through
//!   `WKUIDelegate.webViewDidClose:`, which wry's delegate lacks, so a popup
//!   gets a delegate of its own that handles that and forwards every other
//!   call to wry's.
#![allow(unsafe_code)]

use dispatch2::MainThreadBound;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel},
};
use objc2_app_kit::NSView;
use objc2_web_kit::{WKUIDelegate, WKWebView};
use std::ptr::NonNull;
use wry::{
    WebViewBuilderExtMacos as _, WebViewExtMacOS as _,
    raw_window_handle::{AppKitWindowHandle, HandleError, HasWindowHandle, WindowHandle},
};

/// A popup's page before the window adopts it. It may only be touched on the
/// main thread, where WebKit asks for it and where the window adopts it.
pub(crate) struct Popup(MainThreadBound<Built>);

impl std::fmt::Debug for Popup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Popup")
    }
}

struct Built {
    view: wry::WebView,
    delegate: Retained<Closer>,
}

impl Popup {
    /// The native view WebKit shows the popup in, for its answer.
    pub(super) fn webview(&self, mtm: MainThreadMarker) -> Retained<WKWebView> {
        Retained::into_super(self.0.get(mtm).view.webview())
    }

    /// The wry view, and the delegate it needs kept alive as long as it is.
    pub(super) fn into_parts(self, mtm: MainThreadMarker) -> (wry::WebView, Retained<Closer>) {
        let built = self.0.into_inner(mtm);
        (built.view, built.delegate)
    }
}

/// Builds the popup `opener` asked for with `builder`, which carries the
/// popup's own handlers. `closed` runs when the popup's script closes it.
pub(super) fn build(
    builder: wry::WebViewBuilder<'_>,
    opener: wry::NewWindowOpener,
    closed: impl Fn() + 'static,
    mtm: MainThreadMarker,
) -> crate::Result<Popup> {
    // SAFETY: a property read on a live view, on the main thread `mtm` proves;
    // the parent comes back retained.
    let parent = unsafe { opener.webview.superview() }.ok_or(crate::Error::PopupOpener)?;
    let view = builder
        .with_webview_configuration(opener.target_configuration)
        // Hidden until the window lays it out as a tab.
        .with_visible(false)
        .build_as_child(&Parent(parent))?;
    let webview = view.webview();
    // SAFETY: a property read on the view just built, on the main thread.
    let forward = unsafe { webview.UIDelegate() }.ok_or(crate::Error::PopupOpener)?;
    let delegate = Closer::new(forward, Box::new(closed), mtm);
    // SAFETY: the delegate property is weak; `Built` keeps `delegate` alive
    // as long as the view, and wry keeps the delegate it forwards to.
    unsafe { webview.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    Ok(Popup(MainThreadBound::new(Built { view, delegate }, mtm)))
}

/// The opener's parent view, as the window handle wry builds a child of.
struct Parent(Retained<NSView>);

impl HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let view = NonNull::from(&*self.0).cast();
        // SAFETY: the handle borrows `self`, which retains the view, so the
        // view outlives every use of the handle.
        Ok(unsafe { WindowHandle::borrow_raw(AppKitWindowHandle::new(view).into()) })
    }
}

pub(crate) struct CloserIvars {
    forward: Retained<ProtocolObject<dyn WKUIDelegate>>,
    closed: Box<dyn Fn()>,
}

define_class!(
    /// A popup's UI delegate: handles `webViewDidClose:` and forwards every
    /// other delegate call to wry's delegate for the view.
    // SAFETY: NSObject has no subclassing requirements, and `Closer` does not
    // implement `Drop`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HerdrPopupUIDelegate"]
    #[ivars = CloserIvars]
    pub(crate) struct Closer;

    impl Closer {
        // WebKit asks once which delegate methods exist, so the answer must
        // include the ones forwarded.
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            // SAFETY: `respondsToSelector:` takes a selector and returns a BOOL.
            let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            own || self.ivars().forward.respondsToSelector(selector)
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target(&self, _selector: Sel) -> *mut AnyObject {
            let forward: &AnyObject = self.ivars().forward.as_ref();
            std::ptr::from_ref(forward).cast_mut()
        }
    }

    unsafe impl NSObjectProtocol for Closer {}

    unsafe impl WKUIDelegate for Closer {
        #[unsafe(method(webViewDidClose:))]
        fn web_view_did_close(&self, _web_view: &WKWebView) {
            (self.ivars().closed)();
        }
    }
);

impl Closer {
    fn new(
        forward: Retained<ProtocolObject<dyn WKUIDelegate>>,
        closed: Box<dyn Fn()>,
        mtm: MainThreadMarker,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(CloserIvars { forward, closed });
        // SAFETY: NSObject's `init`, on an allocated instance with its ivars set.
        unsafe { msg_send![super(this), init] }
    }
}
