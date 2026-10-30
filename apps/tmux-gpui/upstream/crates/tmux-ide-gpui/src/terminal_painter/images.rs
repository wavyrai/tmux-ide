//! Images a pane places through Herdr's graphics scene.
//!
//! The worker hands over each image's encoded bytes once; this module turns
//! them into textures off the UI thread, keeps a bounded set of them, and maps
//! each placement onto the same cell grid the text uses. Bytes are untrusted:
//! decoding is capped in pixels and memory, and textures are scaled down to a
//! size every GPU atlas accepts.

use crate::{Error, Result};
use gpui::{App, Bounds, Pixels, RenderImage, Window, point, px, size};
use herdr_client::{
    MAX_IMAGE_SIDE, SurfaceImage, SurfaceImages,
    protocol::{
        SurfaceGraphicsAssetKey, SurfaceGraphicsFormat, SurfaceGraphicsPlacement,
        SurfaceGraphicsSource, SurfaceGraphicsTarget,
    },
};
use image::{Frame, ImageFormat, ImageReader, Limits, RgbaImage, imageops::FilterType};
use std::{
    collections::HashMap,
    io::Cursor,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

/// Decoded bytes one PNG may allocate.
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
/// Textures are scaled to fit this side, which every GPUI atlas accepts.
const MAX_TEXTURE_SIDE: u32 = 4_096;
/// Decoded texture bytes kept per window.
const MAX_TEXTURE_BYTES: usize = 256 * 1024 * 1024;
/// Textures, failures, and decodes in flight kept per window.
const MAX_ENTRIES: usize = 128;
/// Decodes running at once; further images wait for a later paint.
const MAX_DECODES: usize = 2;
/// A texture no paint used for this long is released.
const IDLE: Duration = Duration::from_secs(60);

/// Kitty draws `z < 0` below text and anything else above it.
pub(crate) fn below_text(z: i32) -> bool {
    z < 0
}

/// Which frame's placements to paint: the main grid's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImageTarget {
    Main,
}

impl ImageTarget {
    fn places(self, source: &SurfaceGraphicsSource) -> bool {
        match self {
            Self::Main => matches!(
                source,
                SurfaceGraphicsSource::Terminal {
                    target: SurfaceGraphicsTarget::Pane { .. },
                    ..
                } | SurfaceGraphicsSource::PaneLayer { .. }
            ),
        }
    }
}

/// The placements one frame paints, with the pixels they refer to.
#[derive(Clone, Copy)]
pub(crate) struct PlacedImages<'a> {
    pub(crate) placements: &'a [SurfaceGraphicsPlacement],
    pub(crate) images: &'a SurfaceImages,
    pub(crate) target: ImageTarget,
    /// The cell size the program was told in device pixels, when it was.
    pub(crate) cell_pixels: Option<CellPixels>,
}

impl<'a> PlacedImages<'a> {
    fn resolved(self) -> impl Iterator<Item = (&'a SurfaceGraphicsPlacement, &'a SurfaceImage)> {
        self.placements
            .iter()
            .filter(move |placement| self.target.places(&placement.asset.source))
            .filter_map(move |placement| Some((placement, self.images.get(&placement.asset)?)))
    }
}

/// Where a placement lands: the visible part, and the whole image positioned
/// so its source rectangle fills that part.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ImageGeometry {
    pub(crate) visible: Bounds<Pixels>,
    pub(crate) image: Bounds<Pixels>,
}

/// The cell size a pane's program was told, in device pixels, with the
/// window's device pixels per point. Placements sized for those cells paint
/// 1:1 instead of being stretched over the cells' point size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CellPixels {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) scale: f32,
}

/// Maps a placement onto the grid at `origin`, as Herdr's own client does:
/// the leading pixel offsets shrink the image inside its cells, and the
/// source rectangle (zero meaning the whole image) is stretched over the
/// rest. Offsets arrive in the whole-pixel cell size this client reported.
///
/// With `pixels`, offsets are in those device pixels, and a source within
/// half a pixel per cell of its cells (rounding to whole pixels) is drawn 1:1
/// on device pixels from a pixel-aligned origin. Any other source, such as a
/// frame drawn for a size a daemon never passed on, is still stretched.
pub(crate) fn geometry(
    placement: &SurfaceGraphicsPlacement,
    origin: gpui::Point<Pixels>,
    cell: (f32, f32),
    grid: Bounds<Pixels>,
    pixels: Option<CellPixels>,
) -> Option<ImageGeometry> {
    let key = &placement.asset;
    let (cell_width, cell_height) = cell;
    let reported = pixels.map_or((cell_width.round(), cell_height.round()), |pixels| {
        (pixels.width as f32, pixels.height as f32)
    });
    let span = |start: u16, cells: u32, offset: u32, cell: f32, reported: f32| {
        let reported = reported.max(1.);
        let length = cells as f32 * cell;
        let offset = (offset as f32).min(cells as f32 * reported - 1.).max(0.) * cell / reported;
        (f32::from(start) * cell + offset, length - offset)
    };
    let source = |start: u32, length: u32, image: u32| {
        let length = if length == 0 { image } else { length };
        let length = length.min(image.checked_sub(start)?);
        (length > 0).then_some((start as f32, length as f32))
    };
    let (x, width) = span(
        placement.x,
        placement.cols,
        placement.x_offset,
        cell_width,
        reported.0,
    );
    let (y, height) = span(
        placement.y,
        placement.rows,
        placement.y_offset,
        cell_height,
        reported.1,
    );
    let (source_x, source_width) =
        source(placement.source_x, placement.source_width, key.image_width)?;
    let (source_y, source_height) = source(
        placement.source_y,
        placement.source_height,
        key.image_height,
    )?;
    if width <= 0. || height <= 0. {
        return None;
    }
    let target = Bounds::new(origin + point(px(x), px(y)), size(px(width), px(height)));
    let stretch = (width / source_width, height / source_height);
    let (target, (scale_x, scale_y)) = match pixels {
        Some(pixels) if pixels.scale > 0. => {
            let scale = pixels.scale;
            let fits = |length: f32, source: f32, cells: u32| {
                (length * scale - source).abs() <= cells as f32 / 2. + 1.
            };
            if fits(width, source_width, placement.cols)
                && fits(height, source_height, placement.rows)
            {
                let snap = |value: Pixels| px((f32::from(value) * scale).round() / scale);
                let at = point(snap(target.origin.x), snap(target.origin.y));
                let drawn = size(px(source_width / scale), px(source_height / scale));
                (Bounds::new(at, drawn), (1. / scale, 1. / scale))
            } else {
                (target, stretch)
            }
        }
        _ => (target, stretch),
    };
    let visible = target.intersect(&grid);
    if visible.size.width <= Pixels::ZERO || visible.size.height <= Pixels::ZERO {
        return None;
    }
    let image = Bounds::new(
        target.origin - point(px(source_x * scale_x), px(source_y * scale_y)),
        size(
            px(key.image_width as f32 * scale_x),
            px(key.image_height as f32 * scale_y),
        ),
    );
    Some(ImageGeometry { visible, image })
}

/// Decodes `data` into the BGRA texture GPUI uploads, scaled to fit
/// `MAX_TEXTURE_SIDE`. The placement keeps mapping onto the key's size.
pub(crate) fn decode(key: &SurfaceGraphicsAssetKey, data: &[u8]) -> Result<RgbaImage> {
    if !herdr_client::valid_asset(key, data) {
        return Err(Error::PaneImageLimit);
    }
    let (width, height) = (key.image_width, key.image_height);
    let pixels = match key.format {
        SurfaceGraphicsFormat::Rgb => RgbaImage::from_raw(
            width,
            height,
            data.chunks_exact(3)
                .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 0xff])
                .collect(),
        ),
        SurfaceGraphicsFormat::Rgba => RgbaImage::from_raw(width, height, data.to_vec()),
        SurfaceGraphicsFormat::Png => {
            let mut reader = ImageReader::with_format(Cursor::new(data), ImageFormat::Png);
            let mut limits = Limits::default();
            limits.max_image_width = Some(MAX_IMAGE_SIDE);
            limits.max_image_height = Some(MAX_IMAGE_SIDE);
            limits.max_alloc = Some(MAX_DECODE_BYTES);
            reader.limits(limits);
            Some(
                reader
                    .decode()
                    .map_err(Error::PaneImageDecode)?
                    .into_rgba8(),
            )
        }
    };
    let mut pixels = pixels.ok_or(Error::PaneImageLimit)?;
    let (width, height) = pixels.dimensions();
    if width > MAX_TEXTURE_SIDE || height > MAX_TEXTURE_SIDE {
        let scale = f64::from(MAX_TEXTURE_SIDE) / f64::from(width.max(height));
        let fit = |side: u32| ((f64::from(side) * scale).round() as u32).clamp(1, MAX_TEXTURE_SIDE);
        pixels = image::imageops::resize(&pixels, fit(width), fit(height), FilterType::Triangle);
    }
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Ok(pixels)
}

enum State {
    Decoding,
    Ready(Arc<RenderImage>),
    Failed,
}

struct Entry {
    state: State,
    bytes: usize,
    used: Instant,
    tick: u64,
}

/// What a paint should do about one image.
pub(crate) enum Lookup {
    Ready(Arc<RenderImage>),
    /// Start decoding it; the entry now counts as in flight.
    Decode,
    /// Decoding, failed, or no room to start yet.
    Wait,
}

type Finished = Arc<Mutex<Vec<(u64, Result<RgbaImage>)>>>;

/// Textures for one window, keyed by the serial of the bytes they came from,
/// so a key delivered again (another connection or boot) never reuses a stale
/// texture. Evicted textures leave GPUI's atlas at the next paint.
#[derive(Default)]
pub(crate) struct ImageCache {
    entries: HashMap<u64, Entry>,
    bytes: usize,
    decoding: usize,
    tick: u64,
    finished: Finished,
    /// tmux-ide: the texture each placement rectangle last painted. A program
    /// that redraws its image every frame (a new serial each time) would
    /// otherwise always wait on a decode and never paint; until the newer
    /// texture is ready, the previous one stays up.
    last: HashMap<Slot, (u64, Arc<RenderImage>)>,
    /// Which rectangle each in-flight decode was started for.
    decoding_for: HashMap<u64, Slot>,
}

type Slot = (u16, u16, u32, u32);

impl ImageCache {
    /// Starts a paint: applies finished decodes and returns textures to
    /// release from the atlas.
    pub(crate) fn begin(&mut self, now: Instant) -> Vec<Arc<RenderImage>> {
        self.tick += 1;
        let finished =
            std::mem::take(&mut *self.finished.lock().unwrap_or_else(PoisonError::into_inner));
        for (serial, result) in finished {
            self.finish(serial, result.map(|pixels| Arc::new(texture(pixels))));
        }
        self.evict(now)
    }

    pub(crate) fn lookup(&mut self, serial: u64, now: Instant) -> Lookup {
        if let Some(entry) = self.entries.get_mut(&serial) {
            entry.used = now;
            entry.tick = self.tick;
            return match &entry.state {
                State::Ready(texture) => Lookup::Ready(texture.clone()),
                State::Decoding | State::Failed => Lookup::Wait,
            };
        }
        if self.decoding >= MAX_DECODES || self.entries.len() >= MAX_ENTRIES {
            return Lookup::Wait;
        }
        self.decoding += 1;
        self.entries.insert(
            serial,
            Entry {
                state: State::Decoding,
                bytes: 0,
                used: now,
                tick: self.tick,
            },
        );
        Lookup::Decode
    }

    pub(crate) fn finish(&mut self, serial: u64, result: Result<Arc<RenderImage>>) {
        let Some(entry) = self
            .entries
            .get_mut(&serial)
            .filter(|entry| matches!(entry.state, State::Decoding))
        else {
            return;
        };
        self.decoding -= 1;
        match result {
            Ok(texture) => {
                // A finished decode becomes its rectangle's fallback even if
                // a newer image has been placed there since.
                if let Some(slot) = self.decoding_for.remove(&serial)
                    && self
                        .last
                        .get(&slot)
                        .is_none_or(|(shown, _)| *shown < serial)
                {
                    self.last.insert(slot, (serial, texture.clone()));
                }
                let dimensions = texture.size(0);
                entry.bytes = (dimensions.width.0.max(0) as usize)
                    .saturating_mul(dimensions.height.0.max(0) as usize)
                    .saturating_mul(4);
                self.bytes += entry.bytes;
                entry.state = State::Ready(texture);
            }
            Err(error) => {
                self.decoding_for.remove(&serial);
                tracing::debug!(category = "pane_images", %error, "image not shown");
                entry.state = State::Failed;
            }
        }
    }

    /// Drops idle entries, then the least recently used ones while over
    /// budget. Decodes in flight and anything this paint used stay.
    fn evict(&mut self, now: Instant) -> Vec<Arc<RenderImage>> {
        let mut released = Vec::new();
        let mut remove = |entries: &mut HashMap<u64, Entry>, bytes: &mut usize, serial| {
            if let Some(entry) = entries.remove(&serial) {
                *bytes -= entry.bytes;
                if let State::Ready(texture) = entry.state {
                    released.push(texture);
                }
            }
        };
        let idle: Vec<u64> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                !matches!(entry.state, State::Decoding) && now.duration_since(entry.used) >= IDLE
            })
            .map(|(serial, _)| *serial)
            .collect();
        for serial in idle {
            remove(&mut self.entries, &mut self.bytes, serial);
        }
        while self.bytes > MAX_TEXTURE_BYTES || self.entries.len() > MAX_ENTRIES {
            let Some(serial) = self
                .entries
                .iter()
                .filter(|(_, entry)| {
                    !matches!(entry.state, State::Decoding) && entry.tick < self.tick
                })
                .min_by_key(|(_, entry)| entry.tick)
                .map(|(serial, _)| *serial)
            else {
                break;
            };
            remove(&mut self.entries, &mut self.bytes, serial);
        }
        released
    }

    /// Starts a paint and drops the textures it evicts from the atlas. A
    /// paint with placements does this as it prepares them; one without must
    /// call it, or the textures of images that went away stay resident.
    pub(crate) fn release_idle(&mut self, window: &mut Window) {
        for texture in self.begin(Instant::now()) {
            let _ = window.drop_image(texture);
        }
    }

    /// Resolves the textures and geometry for one frame's placements,
    /// starting background decodes for images not yet decoded. Placements
    /// whose texture is not ready are skipped this paint; a finished decode
    /// refreshes the window.
    pub(crate) fn prepare(
        &mut self,
        images: PlacedImages<'_>,
        origin: gpui::Point<Pixels>,
        cell: (f32, f32),
        grid: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Vec<(i32, ImageGeometry, Arc<RenderImage>)> {
        self.release_idle(window);
        let now = Instant::now();
        let mut placed = Vec::new();
        let mut slots = Vec::new();
        for (placement, image) in images.resolved() {
            let Some(geometry) = geometry(placement, origin, cell, grid, images.cell_pixels) else {
                continue;
            };
            let slot = (placement.x, placement.y, placement.cols, placement.rows);
            slots.push(slot);
            let serial = image.serial();
            let texture = match self.lookup(serial, now) {
                Lookup::Ready(texture) => {
                    self.last.insert(slot, (serial, texture.clone()));
                    Some(texture)
                }
                Lookup::Decode => {
                    self.decoding_for.insert(serial, slot);
                    self.spawn(image, &placement.asset, window, cx);
                    self.last.get(&slot).map(|(_, texture)| texture.clone())
                }
                Lookup::Wait => self.last.get(&slot).map(|(_, texture)| texture.clone()),
            };
            if let Some(texture) = texture {
                placed.push((placement.z, geometry, texture));
            }
        }
        self.last.retain(|slot, _| slots.contains(slot));
        // Lower z paints first; equal z keeps the scene's order.
        placed.sort_by_key(|(z, ..)| *z);
        placed
    }

    fn spawn(
        &self,
        image: &SurfaceImage,
        key: &SurfaceGraphicsAssetKey,
        window: &Window,
        cx: &App,
    ) {
        let (serial, data, key) = (image.serial(), image.data().clone(), key.clone());
        let finished = self.finished.clone();
        let decoded = cx
            .background_executor()
            .spawn(async move { decode(&key, &data) });
        window
            .spawn(cx, async move |cx| {
                let result = decoded.await;
                finished
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push((serial, result));
                let _ = cx.update(|window, _| window.refresh());
            })
            .detach();
    }
}

fn texture(pixels: RgbaImage) -> RenderImage {
    RenderImage::new(vec![Frame::new(pixels)])
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
