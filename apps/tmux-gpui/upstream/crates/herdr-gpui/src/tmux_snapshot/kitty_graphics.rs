//! tmux-ide addition: kitty graphics protocol images for tmux panes.
//!
//! The bridge publishes placements in canvas cells (resolved from the same
//! cells this window paints) and streams image bytes as bounded chunk lines,
//! once per content digest. This module assembles those chunks into a bounded
//! LRU of images and maps placements onto the painter's existing graphics
//! scene, so `terminal_painter/images.rs` decodes and paints them.
use super::Error;
use herdr_client::{
    SurfaceImages,
    protocol::{
        SurfaceGraphicsAsset, SurfaceGraphicsAssetKey, SurfaceGraphicsFormat,
        SurfaceGraphicsPlacement, SurfaceGraphicsSource, SurfaceGraphicsTarget,
    },
};
use serde::Deserialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

/// Encoded image bytes kept per window.
const MAX_BYTES: usize = 256 * 1024 * 1024;
const MAX_IMAGES: usize = 512;
/// Largest image the daemon publishes, and largest inflated raw image.
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PARTIALS: usize = 16;
/// A partial transfer with no progress for this long was dropped upstream.
const STALLED: Duration = Duration::from_secs(10);
/// A referenced image that never started arriving is reported after this.
const UNSEEN: Duration = Duration::from_secs(3);
/// Re-report a missing image at most this often.
const REPORT_AGAIN: Duration = Duration::from_secs(10);
const MAX_PLACEMENTS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Format {
    Png,
    Rgba,
    Rgb,
    /// Raw pixels still deflated as the program sent them (`o=z`).
    #[serde(rename = "rgba-zlib")]
    RgbaZlib,
    #[serde(rename = "rgb-zlib")]
    RgbZlib,
}

impl Format {
    /// The painter's format once any deflate layer is removed, and the raw
    /// byte count a deflated image must inflate to.
    fn painted(self, width: u32, height: u32) -> (SurfaceGraphicsFormat, Option<u64>) {
        let pixels = u64::from(width) * u64::from(height);
        match self {
            Self::Png => (SurfaceGraphicsFormat::Png, None),
            Self::Rgba => (SurfaceGraphicsFormat::Rgba, None),
            Self::Rgb => (SurfaceGraphicsFormat::Rgb, None),
            Self::RgbaZlib => (SurfaceGraphicsFormat::Rgba, Some(pixels * 4)),
            Self::RgbZlib => (SurfaceGraphicsFormat::Rgb, Some(pixels * 3)),
        }
    }
}

/// Inflates exactly `expected` bytes, refusing anything larger.
fn inflate(data: &[u8], expected: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    if expected > MAX_IMAGE_BYTES {
        return None;
    }
    let mut out = Vec::with_capacity(usize::try_from(expected).ok()?);
    flate2::read::ZlibDecoder::new(data)
        .take(expected + 1)
        .read_to_end(&mut out)
        .ok()?;
    (out.len() as u64 == expected).then_some(out)
}

/// One placement in canvas cells: the visible rectangle shows the
/// `source*`/`total*` fraction of the image.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Placement {
    pub digest: String,
    pub row: u16,
    pub column: u16,
    pub rows: u16,
    pub columns: u16,
    pub source_row: u16,
    pub source_column: u16,
    pub total_rows: u16,
    pub total_columns: u16,
    /// The program's image (pane and image id); its newest complete bytes are
    /// painted even before a publication names them.
    #[serde(default)]
    pub image: Option<String>,
}

impl Placement {
    fn slot(&self) -> (u16, u16, u16, u16) {
        (self.row, self.column, self.rows, self.columns)
    }

    fn painted(&self, index: usize, key: SurfaceGraphicsAssetKey) -> SurfaceGraphicsPlacement {
        let scale = |cells: u16, total: u16, side: u32| {
            (u64::from(cells) * u64::from(side) / u64::from(total)) as u32
        };
        SurfaceGraphicsPlacement {
            logical_placement_id: u32::try_from(index).unwrap_or(u32::MAX),
            x: self.column,
            y: self.row,
            cols: u32::from(self.columns),
            rows: u32::from(self.rows),
            source_x: scale(self.source_column, self.total_columns, key.image_width),
            source_y: scale(self.source_row, self.total_rows, key.image_height),
            source_width: scale(self.columns, self.total_columns, key.image_width).max(1),
            source_height: scale(self.rows, self.total_rows, key.image_height).max(1),
            x_offset: 0,
            y_offset: 0,
            z: 0,
            scrollback_offset: 0,
            asset: key,
        }
    }

    fn valid(&self) -> bool {
        valid_digest(&self.digest)
            && self.rows >= 1
            && self.columns >= 1
            && self.total_rows >= 1
            && self.total_columns >= 1
            && u32::from(self.source_row) + u32::from(self.rows) <= u32::from(self.total_rows)
            && u32::from(self.source_column) + u32::from(self.columns)
                <= u32::from(self.total_columns)
    }
}

/// Validates publication placements against the frame they decorate.
pub(super) fn validate(placements: &[Placement], width: u16, height: u16) -> Result<(), Error> {
    if placements.len() > MAX_PLACEMENTS
        || placements.iter().any(|p| {
            !p.valid()
                || u32::from(p.row) + u32::from(p.rows) > u32::from(height)
                || u32::from(p.column) + u32::from(p.columns) > u32::from(width)
        })
    {
        return Err(Error::Invalid("invalid kitty graphics placements"));
    }
    Ok(())
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 32
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChunkLine {
    #[serde(rename = "kittyImageChunk")]
    chunk: Chunk,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    digest: String,
    format: Format,
    width: u32,
    height: u32,
    total: u64,
    offset: u64,
    #[serde(default)]
    image: Option<String>,
    data: String,
}

/// True for an image chunk line (checked before publication parsing).
pub(super) fn is_chunk_line(line: &[u8]) -> bool {
    line.starts_with(b"{\"kittyImageChunk\":")
}

struct Partial {
    image: Option<String>,
    format: Format,
    width: u32,
    height: u32,
    total: usize,
    data: Vec<u8>,
    updated: Instant,
}

#[derive(Default)]
struct Inner {
    images: SurfaceImages,
    keys: HashMap<String, SurfaceGraphicsAssetKey>,
    order: VecDeque<String>,
    bytes: usize,
    partials: HashMap<String, Partial>,
    referenced: HashMap<String, Instant>,
    reported: HashMap<String, Instant>,
    /// Last image painted in each placement rectangle: while a redrawn image
    /// is still arriving, the previous one stays up instead of flickering.
    painted: HashMap<(u16, u16, u16, u16), String>,
    /// Newest complete digest per program image.
    latest: HashMap<String, String>,
    /// Latest received digest, including work still inflating.
    arrivals: HashMap<String, String>,
    changed: bool,
}

/// Shared between the publication reader thread and the window.
#[derive(Clone, Default)]
pub(super) struct Store(Arc<Mutex<Inner>>, Arc<Inflater>);

/// Deflated images inflate on one worker thread, so the publication reader
/// keeps draining its pipe. A newer frame of the same program image replaces
/// a queued older one: only the newest is worth inflating.
#[derive(Default)]
struct Inflater {
    queue: Arc<Mutex<VecDeque<(String, Partial)>>>,
    wake: Arc<std::sync::Condvar>,
    busy: Arc<std::sync::atomic::AtomicBool>,
    stopped: Arc<std::sync::atomic::AtomicBool>,
    started: std::sync::OnceLock<()>,
}

impl Drop for Inflater {
    fn drop(&mut self) {
        // The worker owns only these shared primitives, never the Store or
        // Inflater owner. Close and wake under the queue lock to avoid a lost
        // notification. An in-flight bounded decode may finish; never join it
        // on the window thread, and discard queued work immediately.
        let mut queue = self.queue.lock().unwrap_or_else(PoisonError::into_inner);
        self.stopped
            .store(true, std::sync::atomic::Ordering::SeqCst);
        queue.clear();
        self.wake.notify_one();
    }
}

impl Store {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Accepts one chunk line. Out-of-order or inconsistent chunks drop the
    /// partial image; the window reports it missing and the bridge resends.
    pub(super) fn accept_line(&self, line: &[u8]) -> Result<(), Error> {
        let ChunkLine { chunk } = serde_json::from_slice(line)?;
        let data = base64(&chunk.data).ok_or(Error::Invalid("kitty image data is not base64"))?;
        if !valid_digest(&chunk.digest)
            || chunk.total == 0
            || chunk.total > MAX_IMAGE_BYTES
            || chunk.width == 0
            || chunk.height == 0
            || data.is_empty()
        {
            return Err(Error::Invalid("invalid kitty image chunk"));
        }
        let mut inner = self.lock();
        let now = Instant::now();
        if inner.keys.contains_key(&chunk.digest) {
            if chunk.offset == 0
                && let Some(image) = &chunk.image
            {
                inner.note_arrival(image, &chunk.digest);
                inner.mark_latest(image.clone(), chunk.digest.clone());
                inner.changed = true;
            }
            return Ok(());
        }
        let total = chunk.total as usize;
        if chunk.offset == 0 {
            if inner.partials.len() >= MAX_PARTIALS
                && let Some(oldest) = inner
                    .partials
                    .iter()
                    .min_by_key(|(_, p)| p.updated)
                    .map(|(d, _)| d.clone())
            {
                inner.partials.remove(&oldest);
            }
            inner.partials.insert(
                chunk.digest.clone(),
                Partial {
                    image: chunk.image.clone(),
                    format: chunk.format,
                    width: chunk.width,
                    height: chunk.height,
                    total,
                    data: Vec::with_capacity(total),
                    updated: now,
                },
            );
        }
        let Some(partial) = inner.partials.get_mut(&chunk.digest) else {
            return Ok(());
        };
        if partial.data.len() as u64 != chunk.offset
            || partial.total != total
            || partial.format != chunk.format
            || partial.data.len() + data.len() > total
        {
            inner.partials.remove(&chunk.digest);
            return Ok(());
        }
        partial.data.extend_from_slice(&data);
        partial.updated = now;
        if partial.data.len() < total {
            return Ok(());
        }
        let Some(partial) = inner.partials.remove(&chunk.digest) else {
            return Ok(());
        };
        // Inflate without the lock: the window keeps painting meanwhile.
        drop(inner);
        if matches!(partial.format, Format::RgbaZlib | Format::RgbZlib) {
            self.inflate_later(chunk.digest, partial);
        } else {
            self.complete(chunk.digest, partial);
        }
        Ok(())
    }

    fn complete(&self, digest: String, partial: Partial) {
        self.note_arrival(&digest, &partial);
        let image = partial.image.clone();
        let Some(ready) = Ready::from(partial) else {
            return;
        };
        Self::insert_ready(&self.0, digest, image, ready);
    }

    fn insert_ready(inner: &Mutex<Inner>, digest: String, image: Option<String>, ready: Ready) {
        let mut inner = inner.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(image) = &image
            && inner.arrivals.get(image) != Some(&digest)
        {
            return;
        }
        inner.insert(digest.clone(), ready);
        if let Some(image) = image
            && inner.keys.contains_key(&digest)
        {
            inner.mark_latest(image, digest);
        }
    }

    fn note_arrival(&self, digest: &str, partial: &Partial) {
        if let Some(image) = &partial.image {
            let mut inner = self.lock();
            inner.note_arrival(image, digest);
        }
    }

    fn inflate_later(&self, digest: String, partial: Partial) {
        self.note_arrival(&digest, &partial);
        let inflater = &self.1;
        {
            let mut queue = inflater
                .queue
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if partial.image.is_some() {
                queue.retain(|(_, queued)| queued.image != partial.image);
            }
            let mut bytes = queue
                .iter()
                .map(|(_, queued)| queued.data.len())
                .sum::<usize>();
            while queue.len() >= MAX_PARTIALS
                || bytes + partial.data.len() > MAX_IMAGE_BYTES as usize
            {
                let Some((_, oldest)) = queue.pop_front() else {
                    return;
                };
                bytes -= oldest.data.len();
            }
            queue.push_back((digest, partial));
        }
        inflater.wake.notify_one();
        inflater.started.get_or_init(|| {
            let inner = Arc::downgrade(&self.0);
            let queue = inflater.queue.clone();
            let wake = inflater.wake.clone();
            let busy = inflater.busy.clone();
            let stopped = inflater.stopped.clone();
            std::thread::spawn(move || {
                loop {
                    let next = {
                        let mut queue = queue.lock().unwrap_or_else(PoisonError::into_inner);
                        loop {
                            if stopped.load(std::sync::atomic::Ordering::SeqCst) {
                                return;
                            }
                            if let Some(next) = queue.pop_front() {
                                busy.store(true, std::sync::atomic::Ordering::SeqCst);
                                break next;
                            }
                            queue = wake.wait(queue).unwrap_or_else(PoisonError::into_inner);
                        }
                    };
                    let image = next.1.image.clone();
                    let ready = Ready::from(next.1);
                    if let (Some(inner), Some(ready)) = (inner.upgrade(), ready) {
                        Self::insert_ready(&inner, next.0, image, ready);
                    }
                    busy.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            });
        });
    }

    /// Test seam: wait until queued images are inflated.
    #[cfg(test)]
    pub(super) fn settle(&self) {
        for _ in 0..500 {
            let idle = self
                .1
                .queue
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty()
                && !self.1.busy.load(std::sync::atomic::Ordering::SeqCst);
            if idle {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Placements whose images are present, as the painter's scene; records
    /// references so absent images can be reported.
    pub(super) fn scene(&self, placements: &[Placement]) -> Vec<SurfaceGraphicsPlacement> {
        let mut inner = self.lock();
        let now = Instant::now();
        inner
            .referenced
            .retain(|digest, _| placements.iter().any(|p| &p.digest == digest));
        let slots: Vec<_> = placements.iter().map(Placement::slot).collect();
        inner.painted.retain(|slot, _| slots.contains(slot));
        let mut scene = Vec::with_capacity(placements.len());
        for (index, placement) in placements.iter().enumerate() {
            let slot = placement.slot();
            // A redraw that completed after this publication wins; then the
            // published image; then, while that is still arriving, whatever
            // this rectangle showed last (no flicker between frames).
            let newest = placement
                .image
                .as_ref()
                .and_then(|image| inner.latest.get(image))
                .filter(|digest| inner.keys.contains_key(*digest))
                .cloned();
            let digest = if let Some(newest) = newest {
                newest
            } else if inner.keys.contains_key(&placement.digest) {
                placement.digest.clone()
            } else {
                inner
                    .referenced
                    .entry(placement.digest.clone())
                    .or_insert(now);
                match inner.painted.get(&slot) {
                    Some(previous) if inner.keys.contains_key(previous) => previous.clone(),
                    _ => continue,
                }
            };
            let Some(key) = inner.keys.get(&digest).cloned() else {
                continue;
            };
            inner.painted.insert(slot, digest.clone());
            inner.touch(&digest);
            scene.push(placement.painted(index, key));
        }
        scene
    }

    /// Runs `paint` with the images the scene's placements refer to.
    pub(super) fn with_images<R>(&self, paint: impl FnOnce(&SurfaceImages) -> R) -> R {
        paint(&self.lock().images)
    }

    /// True once after any image completed or was evicted.
    pub(super) fn take_changed(&self) -> bool {
        std::mem::take(&mut self.lock().changed)
    }

    /// Referenced digests that are neither held nor arriving, rate limited.
    pub(super) fn take_missing(&self) -> Vec<String> {
        let mut inner = self.lock();
        let now = Instant::now();
        let Inner {
            partials,
            referenced,
            reported,
            ..
        } = &mut *inner;
        partials.retain(|_, partial| now.duration_since(partial.updated) < STALLED);
        reported.retain(|_, at| now.duration_since(*at) < REPORT_AGAIN);
        let mut missing = Vec::new();
        for (digest, since) in referenced.iter() {
            if partials.contains_key(digest)
                || reported.contains_key(digest)
                || now.duration_since(*since) < UNSEEN
                || missing.len() >= 64
            {
                continue;
            }
            missing.push(digest.clone());
        }
        for digest in &missing {
            reported.insert(digest.clone(), now);
            referenced.insert(digest.clone(), now);
        }
        missing
    }
}

/// A complete image in the painter's format.
struct Ready {
    format: SurfaceGraphicsFormat,
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl Ready {
    fn from(partial: Partial) -> Option<Self> {
        let (format, raw) = partial.format.painted(partial.width, partial.height);
        let data = match raw {
            Some(expected) => inflate(&partial.data, expected)?,
            None => partial.data,
        };
        Some(Self {
            format,
            width: partial.width,
            height: partial.height,
            data,
        })
    }
}

impl Inner {
    fn note_arrival(&mut self, image: &str, digest: &str) {
        if self.arrivals.len() >= MAX_IMAGES && !self.arrivals.contains_key(image) {
            self.arrivals.clear();
        }
        self.arrivals.insert(image.to_owned(), digest.to_owned());
    }

    fn mark_latest(&mut self, image: String, digest: String) {
        if self.latest.len() >= MAX_IMAGES && !self.latest.contains_key(&image) {
            self.latest.clear();
        }
        self.latest.insert(image, digest);
    }

    fn insert(&mut self, digest: String, ready: Ready) {
        let Ready {
            format,
            width,
            height,
            data,
        } = ready;
        let key = SurfaceGraphicsAssetKey {
            source: SurfaceGraphicsSource::Terminal {
                target: SurfaceGraphicsTarget::Pane {
                    pane_id: "tmux".into(),
                },
                image_id: 0,
            },
            image_width: width,
            image_height: height,
            format,
            data_len: data.len() as u64,
            data_fingerprint: u64::from_str_radix(&digest[..16], 16).unwrap_or(0),
        };
        let bytes = data.len();
        if !self.images.insert(SurfaceGraphicsAsset {
            key: key.clone(),
            data,
        }) {
            return;
        }
        self.bytes += bytes;
        self.keys.insert(digest.clone(), key);
        self.order.push_back(digest.clone());
        self.referenced.remove(&digest);
        self.reported.remove(&digest);
        self.changed = true;
        while (self.bytes > MAX_BYTES || self.order.len() > MAX_IMAGES) && self.order.len() > 1 {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(key) = self.keys.remove(&oldest) {
                self.bytes -= key.data_len as usize;
                self.images.remove(&key);
            }
        }
    }

    fn touch(&mut self, digest: &str) {
        if self.order.back().is_some_and(|last| last == digest) {
            return;
        }
        if let Some(index) = self.order.iter().position(|d| d == digest)
            && let Some(digest) = self.order.remove(index)
        {
            self.order.push_back(digest);
        }
    }
}

/// Standard-alphabet base64 decoder (avoids a new dependency edge).
fn base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let bytes = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in bytes {
        acc = (acc << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Static `--tmux-snapshot` files carry graphics inline (developer fixtures).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StaticEnvelope {
    #[serde(default)]
    kitty_graphics: Option<StaticGraphics>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StaticGraphics {
    placements: Vec<Placement>,
    images: Vec<StaticImage>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StaticImage {
    digest: String,
    format: Format,
    width: u32,
    height: u32,
    data: String,
}

/// Loads a static snapshot's inline graphics into `store`; returns its placements.
pub(super) fn load_static(
    bytes: &[u8],
    width: u16,
    height: u16,
    store: &Store,
) -> Result<Vec<Placement>, Error> {
    let StaticEnvelope { kitty_graphics } = serde_json::from_slice(bytes)?;
    let Some(graphics) = kitty_graphics else {
        return Ok(Vec::new());
    };
    validate(&graphics.placements, width, height)?;
    for image in graphics.images {
        let data = base64(&image.data).ok_or(Error::Invalid("kitty image data is not base64"))?;
        if !valid_digest(&image.digest) || data.is_empty() {
            return Err(Error::Invalid("invalid kitty image"));
        }
        let total = data.len();
        let ready = Ready::from(Partial {
            image: None,
            format: image.format,
            width: image.width,
            height: image.height,
            total,
            data,
            updated: Instant::now(),
        })
        .ok_or(Error::Invalid("invalid kitty image"))?;
        store.lock().insert(image.digest, ready);
    }
    Ok(graphics.placements)
}

#[cfg(test)]
#[path = "kitty_graphics_tests.rs"]
mod tests;
