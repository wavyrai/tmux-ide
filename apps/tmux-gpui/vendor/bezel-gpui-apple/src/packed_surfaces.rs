//! tmux-ide addition: lossless packed CoreVideo texture import.
use super::*;
use objc2_core_video::{CVPixelBuffer, kCVPixelFormatType_32BGRA};
pub(super) fn texture(
    cache: &CVMetalTextureCache,
    buffer: &CVPixelBuffer,
) -> Result<Option<CFRetained<CVMetalTexture>>> {
    if CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA {
        return Ok(None);
    }
    let format = objc2_metal::MTLPixelFormat::BGRA8Unorm;
    let mut texture = ptr::null_mut();
    // SAFETY: CoreVideo owns and validates the pixel buffer; the texture cache
    // uses its IOSurface and row stride rather than caller-supplied raw pointers.
    let status = unsafe {
        CVMetalTextureCache::create_texture_from_image(
            None,
            cache,
            buffer,
            None,
            format,
            CVPixelBufferGetWidth(buffer),
            CVPixelBufferGetHeight(buffer),
            0,
            ptr::NonNull::from(&mut texture),
        )
    };
    anyhow::ensure!(
        status == kCVReturnSuccess,
        "packed CoreVideo Metal texture status {status}"
    );
    Ok(Some(unsafe {
        CFRetained::from_raw(
            ptr::NonNull::new(texture).context("CoreVideo returned a null packed texture")?,
        )
    }))
}
