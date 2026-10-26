//! Copy a complete application canvas into independently owned native backing.
//! The input may be reused immediately; the returned buffer must stay immutable.
use herdr_client::tmux_graphics::surface_leases::{Layout, MAX_SURFACE_BYTES};
use objc2_core_foundation::{CFDictionary, CFRetained, CFType};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetDataSize, CVPixelBufferGetIOSurface, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelFormatType_32BGRA, kCVReturnSuccess,
};
use std::ptr::NonNull;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("canvas dimensions or byte length exceed native surface bounds")]
    Bounds,
    #[error("CoreVideo canvas allocation failed ({0})")]
    Allocation(i32),
    #[error("CoreVideo canvas lock failed ({0})")]
    Lock(i32),
    #[error("CoreVideo canvas unlock failed ({0})")]
    Unlock(i32),
    #[error("CoreVideo canvas backing is unavailable or invalid")]
    Backing,
}

fn row_bytes(width: usize, height: usize, len: usize) -> Result<usize, Error> {
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err(Error::Bounds);
    }
    let row = width.checked_mul(4).ok_or(Error::Bounds)?;
    let total = row.checked_mul(height).ok_or(Error::Bounds)?;
    if total != len || total > MAX_SURFACE_BYTES {
        return Err(Error::Bounds);
    }
    Ok(row)
}

/// Converts tightly packed RGBA into a fresh straight-alpha BGRA IOSurface.
/// This is a CPU copy for composited canvases, not zero-copy Chromium rendering.
#[allow(unsafe_code)] // CoreVideo has no safe CPU mapping wrapper. See lock/size invariants below.
pub fn copy_rgba(
    width: usize,
    height: usize,
    rgba: &[u8],
    premultiplied: bool,
) -> Result<CFRetained<CVPixelBuffer>, Error> {
    let row = row_bytes(width, height, rgba.len())?;
    let attributes = CFDictionary::from_slices(
        &[unsafe { kCVPixelBufferIOSurfacePropertiesKey }],
        &[&*CFDictionary::<CFType, CFType>::empty()],
    );
    let mut raw = std::ptr::null_mut();
    let status = unsafe {
        CVPixelBufferCreate(
            None,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            Some(attributes.as_opaque()),
            NonNull::from(&mut raw),
        )
    };
    if status != kCVReturnSuccess {
        return Err(Error::Allocation(status));
    }
    let buffer = unsafe { CFRetained::from_raw(NonNull::new(raw).ok_or(Error::Backing)?) };
    let surface = CVPixelBufferGetIOSurface(Some(&buffer)).ok_or(Error::Backing)?;
    let stride = CVPixelBufferGetBytesPerRow(&buffer);
    let length = stride.checked_mul(height).ok_or(Error::Backing)?;
    Layout {
        width,
        height,
        stride,
        allocation_bytes: surface.alloc_size(),
    }
    .bytes()
    .map_err(|_| Error::Backing)?;
    if surface.bytes_per_row() != stride || CVPixelBufferGetDataSize(&buffer) < length {
        return Err(Error::Backing);
    }
    let lock = Locked::new(&buffer)?;
    let base =
        NonNull::new(CVPixelBufferGetBaseAddress(&buffer).cast::<u8>()).ok_or(Error::Backing)?;
    // The fresh, exclusively owned buffer is locked for CPU writes. The checked
    // row stride and data size bound this slice; it cannot escape the lock scope.
    let bytes = unsafe { std::slice::from_raw_parts_mut(base.as_ptr(), length) };
    bytes.fill(0);
    for (source, target) in rgba.chunks_exact(row).zip(bytes.chunks_exact_mut(stride)) {
        convert_row(source, &mut target[..row], premultiplied);
    }
    lock.finish()?;
    Ok(buffer)
}

fn convert_row(rgba: &[u8], bgra: &mut [u8], premultiplied: bool) {
    for (source, target) in rgba.chunks_exact(4).zip(bgra.chunks_exact_mut(4)) {
        let alpha = u32::from(source[3]);
        let channel = |value: u8| {
            if !premultiplied {
                value
            } else {
                (u32::from(value) * 255 + alpha / 2)
                    .checked_div(alpha)
                    .unwrap_or(0)
                    .min(255) as u8
            }
        };
        target.copy_from_slice(&[
            channel(source[2]),
            channel(source[1]),
            channel(source[0]),
            source[3],
        ]);
    }
}

struct Locked<'a> {
    buffer: &'a CVPixelBuffer,
    active: bool,
}
impl<'a> Locked<'a> {
    #[allow(unsafe_code)] // The exclusively owned buffer outlives this guard.
    fn new(buffer: &'a CVPixelBuffer) -> Result<Self, Error> {
        let status =
            unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::empty()) };
        if status != kCVReturnSuccess {
            return Err(Error::Lock(status));
        }
        Ok(Self {
            buffer,
            active: true,
        })
    }
    #[allow(unsafe_code)] // Same buffer and flags as the successful lock, exactly once.
    fn finish(mut self) -> Result<(), Error> {
        self.active = false;
        let status =
            unsafe { CVPixelBufferUnlockBaseAddress(self.buffer, CVPixelBufferLockFlags::empty()) };
        if status == kCVReturnSuccess {
            Ok(())
        } else {
            Err(Error::Unlock(status))
        }
    }
}
impl Drop for Locked<'_> {
    #[allow(unsafe_code)] // Error paths release the same successful lock with matching flags.
    fn drop(&mut self) {
        if self.active {
            unsafe {
                CVPixelBufferUnlockBaseAddress(self.buffer, CVPixelBufferLockFlags::empty());
            }
        }
    }
}

#[cfg(test)]
#[path = "canvas_tests.rs"]
mod tests;
