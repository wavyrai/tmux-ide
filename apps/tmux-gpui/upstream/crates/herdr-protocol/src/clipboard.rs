//! Bounds and encoding for upstream's opaque remote clipboard-image message.

use crate::{ClientClipboardImageTarget, ClientMessage, Error, Result, encode_message};

pub const MAX_CLIPBOARD_IMAGE_PAYLOAD: usize = 16 * 1024 * 1024;
pub const MAX_CLIPBOARD_IMAGE_TARGET_BYTES: usize = 1024;
/// Image bytes plus bounded target, extension, and bincode framing overhead.
pub const MAX_CLIPBOARD_IMAGE_FRAME_SIZE: usize = MAX_CLIPBOARD_IMAGE_PAYLOAD + 2048;

pub fn validate_clipboard_image_target(target: &ClientClipboardImageTarget) -> Result<()> {
    match target {
        ClientClipboardImageTarget::DirectTerminal => Ok(()),
        ClientClipboardImageTarget::Pane(id) | ClientClipboardImageTarget::Popup(id)
            if !id.is_empty() && id.len() <= MAX_CLIPBOARD_IMAGE_TARGET_BYTES =>
        {
            Ok(())
        }
        _ => Err(Error::ClipboardImageTarget),
    }
}

/// Like the TUI, accept opaque image bytes, not decoded pixels. No file I/O or
/// content sniffing is performed. JPEG is canonicalized to `jpg`.
pub fn encode_clipboard_image(
    target: ClientClipboardImageTarget,
    extension: &str,
    data: Vec<u8>,
) -> Result<Vec<u8>> {
    validate_clipboard_image_target(&target)?;
    if data.is_empty() || data.len() > MAX_CLIPBOARD_IMAGE_PAYLOAD {
        return Err(Error::ClipboardImageSize);
    }
    let extension = ["png", "jpg", "gif", "webp", "bmp"]
        .into_iter()
        .find(|candidate| extension.eq_ignore_ascii_case(candidate))
        .or_else(|| extension.eq_ignore_ascii_case("jpeg").then_some("jpg"))
        .ok_or(Error::ClipboardImageExtension)?;
    encode_message(
        &ClientMessage::ClipboardImage {
            target,
            extension: extension.into(),
            data,
        },
        MAX_CLIPBOARD_IMAGE_FRAME_SIZE,
    )
}
