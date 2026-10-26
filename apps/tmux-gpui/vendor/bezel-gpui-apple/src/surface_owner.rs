//! tmux-ide: bind a storage reservation to the actual CoreVideo buffer lifetime.
use anyhow::{Context as _, Result};
use objc2_core_foundation::{CFAllocator, CFArray, CFArrayCallBacks, CFString};
use objc2_core_video::{CVAttachmentMode, CVPixelBuffer};
use std::{ffi::c_void, sync::Arc};

/// Attach before publishing the buffer to any scene. The owner must be cheap to
/// drop on a GPU completion thread. Never remove/replace this private attachment
/// or propagate it to copied buffers: it represents this allocation's lifetime.
pub fn retain_surface_owner<T: Send + Sync + 'static>(
    buffer: &CVPixelBuffer,
    owner: Arc<T>,
) -> Result<()> {
    let key = CFString::from_str("org.tmux-ide.surface-storage-owner.v1");
    anyhow::ensure!(
        !buffer.has_attachment(&key),
        "surface already has a storage owner"
    );
    let callbacks = CFArrayCallBacks {
        version: 0,
        retain: Some(retain::<T>),
        release: Some(release::<T>),
        copyDescription: None,
        equal: None,
    };
    let mut pointer = Arc::as_ptr(&owner).cast::<c_void>();
    // SAFETY: owner remains alive during creation. The immutable one-element
    // array copies the callback table and retains this pointer exactly once.
    // No CFType callbacks touch the Rust pointer. Each release balances retain.
    let array = unsafe { CFArray::new(None, &mut pointer, 1, &callbacks) }
        .context("could not allocate surface owner attachment")?;
    // SAFETY: array is a live CFType, retained by CoreVideo. Its opaque element
    // is used only by the paired Arc callbacks above, never exposed as CFType.
    unsafe { buffer.set_attachment(&key, &array, CVAttachmentMode::ShouldNotPropagate) };
    Ok(())
}
unsafe extern "C-unwind" fn retain<T>(
    _: *const CFAllocator,
    value: *const c_void,
) -> *const c_void {
    // SAFETY: only the immutable array above calls this with its live Arc<T>.
    unsafe { Arc::increment_strong_count(value.cast::<T>()) };
    value
}
unsafe extern "C-unwind" fn release<T>(_: *const CFAllocator, value: *const c_void) {
    // SAFETY: one callback per retained array element, balancing retain<T>.
    unsafe { Arc::decrement_strong_count(value.cast::<T>()) };
}
