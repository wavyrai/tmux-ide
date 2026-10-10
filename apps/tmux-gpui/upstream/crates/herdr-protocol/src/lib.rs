//! Stable gen1 wire model with no terminal or server runtime dependencies.
#![doc = include_str!("../README.md")]
pub mod endpoint;
pub mod surface_delta;
pub mod surface_reuse;
pub mod surface_scroll;

mod clipboard;
mod codec;
mod error;
mod frame;
mod wire;

pub use clipboard::{
    MAX_CLIPBOARD_IMAGE_FRAME_SIZE, MAX_CLIPBOARD_IMAGE_PAYLOAD, MAX_CLIPBOARD_IMAGE_TARGET_BYTES,
    encode_clipboard_image, validate_clipboard_image_target,
};
pub use codec::{
    MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE, decode_payload, encode_message, read_message,
    write_message,
};
pub use error::{Error, Result};
pub use wire::*;
