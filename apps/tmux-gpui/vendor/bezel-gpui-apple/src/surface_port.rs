//! tmux-ide: import an owned IOSurface Mach capability, never a global surface ID.
use anyhow::{Context as _, Result, ensure};
use objc2_core_foundation::CFRetained;
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferCreateWithIOSurface, kCVPixelFormatType_32BGRA, kCVReturnSuccess,
};
use objc2_io_surface::IOSurfaceRef;
use std::{
    ptr::{self, NonNull},
    sync::Arc,
};

/// Exactly one send-right reference in the current task. Wire integers are not
/// capabilities: construct only from an actual native IPC receive operation.
pub struct SurfacePort(libc::mach_port_t);
impl SurfacePort {
    pub(crate) fn borrowed_name(&self) -> libc::mach_port_t {
        self.0
    }
    /// # Safety
    /// `port` must be one owned send-right reference received by this task, with
    /// no other Rust owner responsible for deallocating that reference. The IPC
    /// caller must authenticate the peer and correlate its one-shot storage ticket.
    pub unsafe fn from_received_right(port: libc::mach_port_t) -> Result<Self> {
        ensure!(port != 0 && port != u32::MAX, "invalid surface port right");
        Ok(Self(port))
    }
    /// Create one owned send right for a locally owned surface.
    pub fn from_surface(surface: &IOSurfaceRef) -> Result<Self> {
        // SAFETY: IOSurfaceCreateMachPort returns a new owned send-right reference.
        unsafe { Self::from_received_right(surface.create_mach_port()) }
    }
    /// Import only after reserving the full allocation. Ownership is attached to
    /// CoreVideo so renderer/GPU references retain it; no pixels are copied here.
    pub fn import<T: Send + Sync + 'static>(
        self,
        width: usize,
        height: usize,
        stride: usize,
        allocation_bytes: usize,
        owner: Arc<T>,
    ) -> Result<CFRetained<CVPixelBuffer>> {
        ensure!(width > 0 && height > 0, "empty surface geometry");
        ensure!(
            width.checked_mul(4).is_some_and(|row| row <= stride)
                && stride
                    .checked_mul(height)
                    .is_some_and(|bytes| bytes <= allocation_bytes),
            "invalid surface allocation geometry"
        );
        let surface =
            IOSurfaceRef::lookup_from_mach_port(self.0).context("surface port lookup failed")?;
        ensure!(
            surface.width() == width
                && surface.height() == height
                && surface.bytes_per_row() == stride
                && surface.alloc_size() == allocation_bytes
                && surface.plane_count() == 0
                && surface.pixel_format() == kCVPixelFormatType_32BGRA,
            "surface allocation does not match admitted offer"
        );
        let mut buffer = ptr::null_mut();
        // SAFETY: the IOSurface is retained and its immutable geometry/format has
        // been checked. The output pointer lives through this call; no attributes.
        let status = unsafe {
            CVPixelBufferCreateWithIOSurface(None, &surface, None, NonNull::from(&mut buffer))
        };
        ensure!(
            status == kCVReturnSuccess,
            "CoreVideo surface import status {status}"
        );
        // SAFETY: a successful create returns one retained reference.
        let buffer = unsafe {
            CFRetained::from_raw(NonNull::new(buffer).context("null imported pixel buffer")?)
        };
        crate::surface_owner::retain_surface_owner(&buffer, owner)?;
        Ok(buffer)
    }
}
impl Drop for SurfacePort {
    fn drop(&mut self) {
        // SAFETY: this object owns exactly one send-right reference in this task.
        // Import retains the IOSurface independently before this right is released.
        unsafe {
            mach2::mach_port::mach_port_deallocate(mach2::traps::mach_task_self(), self.0);
        }
    }
}
