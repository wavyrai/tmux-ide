//! Pixels for the images a pane surface places.
//!
//! Herdr sends an image's bytes once, in the first surface that places it, and
//! afterwards only references it by key until no placement or retained entry
//! names it. A consumer that coalesces surfaces would miss those bytes, so the
//! worker, which sees every surface in order, keeps them here and publishes
//! the set alongside the surfaces. Bytes are untrusted: each asset must match
//! its key exactly, and counts and total bytes are bounded.

use crate::protocol::{SurfaceGraphicsAsset, SurfaceGraphicsAssetKey, SurfaceGraphicsFormat};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

/// Herdr's own cap on placements in one scene.
pub const MAX_PLACEMENTS: usize = 4_096;
/// Kitty and Ghostty refuse images wider or taller than this.
pub const MAX_IMAGE_SIDE: u32 = 10_000;
/// Distinct images kept for one connection.
pub const MAX_IMAGES: usize = 256;
/// Encoded bytes kept for one connection. Herdr keeps at most 64 MiB of
/// off-screen images; the rest covers what is on screen.
pub const MAX_IMAGE_BYTES: usize = 256 * 1024 * 1024;

/// Unique for the life of the process, so a cache can tell two deliveries of
/// the same key apart, even from different connections or boots.
static NEXT_SERIAL: AtomicU64 = AtomicU64::new(1);

/// One image's encoded bytes, exactly as the key describes them.
#[derive(Clone, Debug)]
pub struct SurfaceImage {
    serial: u64,
    data: Arc<[u8]>,
}

impl SurfaceImage {
    fn new(data: Vec<u8>) -> Self {
        Self {
            serial: NEXT_SERIAL.fetch_add(1, Ordering::Relaxed),
            data: Arc::from(data),
        }
    }

    pub fn serial(&self) -> u64 {
        self.serial
    }

    pub fn data(&self) -> &Arc<[u8]> {
        &self.data
    }
}

/// The images a connection's latest surfaces may place, by asset key.
#[derive(Clone, Debug, Default)]
pub struct SurfaceImages {
    images: HashMap<SurfaceGraphicsAssetKey, SurfaceImage>,
}

impl SurfaceImages {
    pub fn get(&self, key: &SurfaceGraphicsAssetKey) -> Option<&SurfaceImage> {
        self.images.get(key)
    }

    pub fn len(&self) -> usize {
        self.images.len()
    }

    pub fn is_empty(&self) -> bool {
        self.images.is_empty()
    }

    /// Adds one asset when its bytes match its key; false otherwise.
    /// (tmux-ide: images that arrive incrementally rather than per surface.)
    pub fn insert(&mut self, asset: SurfaceGraphicsAsset) -> bool {
        if !valid_asset(&asset.key, &asset.data) {
            return false;
        }
        self.images.insert(asset.key, SurfaceImage::new(asset.data));
        true
    }

    pub fn remove(&mut self, key: &SurfaceGraphicsAssetKey) -> bool {
        self.images.remove(key).is_some()
    }
}

/// Collects valid assets, skipping any whose bytes disagree with their key.
impl FromIterator<SurfaceGraphicsAsset> for SurfaceImages {
    fn from_iter<I: IntoIterator<Item = SurfaceGraphicsAsset>>(assets: I) -> Self {
        let images = assets
            .into_iter()
            .filter(|asset| valid_asset(&asset.key, &asset.data))
            .map(|asset| (asset.key, SurfaceImage::new(asset.data)))
            .collect();
        Self { images }
    }
}

/// Whether `data` is exactly what `key` promises.
pub fn valid_asset(key: &SurfaceGraphicsAssetKey, data: &[u8]) -> bool {
    let sides = 1..=MAX_IMAGE_SIDE;
    if data.is_empty()
        || u64::try_from(data.len()).ok() != Some(key.data_len)
        || !sides.contains(&key.image_width)
        || !sides.contains(&key.image_height)
    {
        return false;
    }
    let pixels = u64::from(key.image_width) * u64::from(key.image_height);
    match key.format {
        SurfaceGraphicsFormat::Rgb => pixels.checked_mul(3) == Some(key.data_len),
        SurfaceGraphicsFormat::Rgba => pixels.checked_mul(4) == Some(key.data_len),
        // Decoded later, under its own limits.
        SurfaceGraphicsFormat::Png => true,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
