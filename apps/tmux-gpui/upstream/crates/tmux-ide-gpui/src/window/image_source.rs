//! Disk-free source recognition; opaque image bytes are prepared off the UI thread.

use crate::{Error, Result};
use gpui::{Image, ImageFormat};
use herdr_client::protocol::MAX_CLIPBOARD_IMAGE_PAYLOAD;
use image::{
    DynamicImage, ImageDecoder, ImageEncoder, ImageReader, Limits,
    codecs::{jpeg::JpegEncoder, png::PngDecoder, png::PngEncoder},
    metadata::Orientation,
};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs::OpenOptions,
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_SOURCE_BYTES: usize = 64 * 1024;
const MAX_READ_DURATION: Duration = Duration::from_secs(3);
/// Source acquisition cap, shared with native clipboard readers. Only encoded
/// inputs up to 128 MiB may enter the background resize fallback.
pub(super) const MAX_IMAGE_INPUT_BYTES: usize = 128 * 1024 * 1024;
const MAX_DECODE_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;

pub(super) struct PreparedImage {
    pub extension: &'static str,
    pub bytes: Vec<u8>,
    /// True when recompressed or downscaled, rather than passed through unchanged.
    pub resized: bool,
}

impl std::fmt::Debug for PreparedImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedImage")
            .field("extension", &self.extension)
            .field("byte_count", &self.bytes.len())
            .field("resized", &self.resized)
            .finish()
    }
}

// Deliberately no Debug: neither local paths nor clipboard bytes belong in logs.
pub(super) enum Source {
    File {
        path: PathBuf,
        extension: &'static str,
    },
    Clipboard(Image),
}

pub(super) fn from_path(path: &Path) -> Option<Source> {
    if path.as_os_str().len() > MAX_SOURCE_BYTES || !path.is_absolute() {
        return None;
    }
    let extension = path.extension()?.to_str()?;
    let extension = ["png", "jpg", "gif", "webp", "bmp"]
        .into_iter()
        .find(|candidate| extension.eq_ignore_ascii_case(candidate))
        .or_else(|| extension.eq_ignore_ascii_case("jpeg").then_some("jpg"))?;
    Some(Source::File {
        path: path.to_owned(),
        extension,
    })
}

/// Match upstream's Unix terminal-drop escaping, even inside matching quotes.
/// Remote GUI image bridging is Unix-only; this is not Windows shell parsing.
pub(super) fn from_paste(text: &str) -> Option<Source> {
    if text.len() > MAX_SOURCE_BYTES {
        return None;
    }
    let text = text
        .strip_prefix("\x1b[200~")
        .and_then(|text| text.strip_suffix("\x1b[201~"))
        .unwrap_or(text)
        .trim_end_matches(['\r', '\n']);
    if text.is_empty() || text.chars().any(char::is_control) {
        return None;
    }
    let text = if text.len() >= 2
        && matches!(
            (text.as_bytes().first(), text.as_bytes().last()),
            (Some(b'\''), Some(b'\'')) | (Some(b'"'), Some(b'"'))
        ) {
        &text[1..text.len() - 1]
    } else {
        text
    };
    let mut path = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        path.push(if ch == '\\' {
            chars.next().unwrap_or(ch)
        } else {
            ch
        });
    }
    from_path(Path::new(&path))
}

impl Source {
    /// Blocking I/O and decoding: call only on a background executor or worker thread.
    /// Inputs within the upload limit remain opaque and unchanged.
    /// The deadline bounds work between reads, not a kernel-blocked filesystem
    /// operation (for example, FUSE); those cannot be interrupted portably.
    pub fn prepare(self) -> Result<PreparedImage> {
        let (extension, bytes) = match self {
            Self::File { path, extension } => {
                let deadline = Instant::now() + MAX_READ_DURATION;
                let mut options = OpenOptions::new();
                options.read(true);
                // Validate the descriptor, not the path: a FIFO swapped into the
                // path before open must not block waiting for a writer.
                #[cfg(unix)]
                options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
                let mut file = options.open(&path).map_err(|source| Error::ImageFile {
                    operation: "open",
                    source,
                })?;
                let metadata = file.metadata().map_err(|source| Error::ImageFile {
                    operation: "inspect",
                    source,
                })?;
                if !metadata.is_file() {
                    return Err(Error::ImageFileType);
                }
                if metadata.len() > MAX_IMAGE_INPUT_BYTES as u64 {
                    return Err(Error::ImageInputTooLarge {
                        limit: MAX_IMAGE_INPUT_BYTES,
                    });
                }
                if metadata.len() == 0 {
                    return Err(Error::ImageSize);
                }
                let mut bytes = Vec::new();
                let mut chunk = [0; 64 * 1024];
                loop {
                    if Instant::now() >= deadline {
                        return Err(Error::ImageReadTimeout);
                    }
                    // One extra byte detects growth past the metadata size.
                    let limit = chunk.len().min(MAX_IMAGE_INPUT_BYTES + 1 - bytes.len());
                    let read = file.read(&mut chunk[..limit]);
                    if Instant::now() >= deadline {
                        return Err(Error::ImageReadTimeout);
                    }
                    if matches!(&read, Err(source) if source.kind() == io::ErrorKind::Interrupted) {
                        continue;
                    }
                    let count = read.map_err(|source| Error::ImageFile {
                        operation: "read",
                        source,
                    })?;
                    if count == 0 {
                        break;
                    }
                    if bytes.len() + count > MAX_IMAGE_INPUT_BYTES {
                        return Err(Error::ImageInputTooLarge {
                            limit: MAX_IMAGE_INPUT_BYTES,
                        });
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                }
                (extension, bytes)
            }
            Self::Clipboard(image) => {
                let extension = match image.format {
                    ImageFormat::Png => "png",
                    ImageFormat::Jpeg => "jpg",
                    ImageFormat::Gif => "gif",
                    ImageFormat::Webp => "webp",
                    ImageFormat::Bmp => "bmp",
                    ImageFormat::Tiff => "tiff",
                    ImageFormat::Svg | ImageFormat::Ico | ImageFormat::Pnm => {
                        return Err(Error::ImageFormat);
                    }
                };
                (extension, image.bytes)
            }
        };
        prepare_bytes(extension, bytes, MAX_CLIPBOARD_IMAGE_PAYLOAD)
    }
}

fn prepare_bytes(
    extension: &'static str,
    bytes: Vec<u8>,
    output_limit: usize,
) -> Result<PreparedImage> {
    if bytes.len() > MAX_IMAGE_INPUT_BYTES {
        return Err(Error::ImageInputTooLarge {
            limit: MAX_IMAGE_INPUT_BYTES,
        });
    }
    if bytes.is_empty() {
        return Err(Error::ImageSize);
    }
    // TIFF is not a bridge format: agents may not read it and the daemon names
    // unknown extensions `.png`. Transcode it even when it already fits.
    let tiff = extension == "tiff";
    if !tiff && bytes.len() <= output_limit {
        return Ok(PreparedImage {
            extension,
            bytes,
            resized: false,
        });
    }
    if matches!(extension, "gif" | "webp") {
        return Err(Error::ImageAnimationResize);
    }
    // Sniff only oversized input; a renamed animation must not become a still.
    let format = image::guess_format(&bytes).map_err(Error::ImageDecode)?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_DECODE_PIXELS as u32);
    limits.max_image_height = Some(MAX_DECODE_PIXELS as u32);
    let decoded = match format {
        image::ImageFormat::Gif | image::ImageFormat::WebP => {
            return Err(Error::ImageAnimationResize);
        }
        image::ImageFormat::Png => {
            let decoder = PngDecoder::with_limits(Cursor::new(&bytes), limits.clone())
                .map_err(Error::ImageDecode)?;
            if decoder.is_apng().map_err(Error::ImageDecode)? {
                return Err(Error::ImageAnimationResize);
            }
            decode_limited(decoder, limits)?
        }
        image::ImageFormat::Jpeg | image::ImageFormat::Bmp | image::ImageFormat::Tiff => {
            let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
            reader.limits(limits.clone());
            decode_limited(reader.into_decoder().map_err(Error::ImageDecode)?, limits)?
        }
        _ => return Err(Error::ImageFormat),
    };
    drop(bytes);
    let alpha = decoded.color().has_alpha();
    let mut raster = if alpha {
        DynamicImage::ImageRgba8(decoded.into_rgba8())
    } else {
        DynamicImage::ImageRgb8(decoded.into_rgb8())
    };
    let mut output = BoundedOutput {
        bytes: Vec::with_capacity(output_limit),
        limit: output_limit,
        exceeded: false,
    };
    // A converted screenshot keeps lossless pixels when they fit; only a TIFF
    // that is too large for PNG takes the lossy resize path below.
    if tiff {
        match PngEncoder::new(&mut output).write_image(
            raster.as_bytes(),
            raster.width(),
            raster.height(),
            raster.color().into(),
        ) {
            Ok(()) => {
                return Ok(PreparedImage {
                    extension: "png",
                    bytes: output.bytes,
                    resized: false,
                });
            }
            Err(_) if output.exceeded => {}
            Err(source) => return Err(Error::ImageEncode(source)),
        }
    }
    let extension = if alpha { "png" } else { "jpg" };
    loop {
        for quality in [90, 80, 65] {
            // JPEG dimensions are 16-bit even when the source format is not.
            if !alpha && (raster.width() > u16::MAX.into() || raster.height() > u16::MAX.into()) {
                break;
            }
            output.bytes.clear();
            output.exceeded = false;
            let encoded = if alpha {
                PngEncoder::new(&mut output).write_image(
                    raster.as_bytes(),
                    raster.width(),
                    raster.height(),
                    raster.color().into(),
                )
            } else {
                JpegEncoder::new_with_quality(&mut output, quality).encode_image(&raster)
            };
            match encoded {
                Ok(()) => {
                    return Ok(PreparedImage {
                        extension,
                        bytes: output.bytes,
                        resized: true,
                    });
                }
                Err(_) if output.exceeded => {}
                Err(source) => return Err(Error::ImageEncode(source)),
            }
            if alpha {
                break;
            }
        }
        if raster.width() == 1 && raster.height() == 1 {
            return Err(Error::ImageTooLarge {
                limit: output_limit,
            });
        }
        // Integer thumbnailing avoids the large floating-point scratch buffer
        // used by filtered resizing. Every failed round reduces the pixel count.
        raster = raster.thumbnail((raster.width() / 2).max(1), (raster.height() / 2).max(1));
    }
}

fn decode_limited(mut decoder: impl ImageDecoder, mut limits: Limits) -> Result<DynamicImage> {
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_DECODE_PIXELS
        || decoder.total_bytes() > MAX_DECODE_BYTES
    {
        return Err(Error::ImageDecodeLimit);
    }
    let orientation = decoder.orientation().map_err(Error::ImageDecode)?;
    // Quarter turns keep the original raster alive while allocating its rotated
    // copy. Flips and 180-degree rotation are in-place in image::apply_orientation.
    if matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    ) && decoder.total_bytes() > MAX_DECODE_BYTES / 2
    {
        return Err(Error::ImageDecodeLimit);
    }
    // Reserve the destination before giving the decoder its remaining budget.
    // Codec scratch limits are best-effort in image; the raster bound is strict.
    limits
        .reserve(decoder.total_bytes())
        .map_err(Error::ImageDecode)?;
    decoder.set_limits(limits).map_err(Error::ImageDecode)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(Error::ImageDecode)?;
    // Re-encoding drops EXIF, so bake its display transform into the pixels first.
    image.apply_orientation(orientation);
    Ok(image)
}

struct BoundedOutput {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit - self.bytes.len() {
            self.exceeded = true;
            return Err(io::ErrorKind::FileTooLarge.into());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
