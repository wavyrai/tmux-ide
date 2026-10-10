//! Public images only. All filesystem access and decoding happens on workers.
#![forbid(unsafe_code)]

use gpui::{Image, ImageFormat};
#[cfg(unix)]
use rustix::fs::{AtFlags, FlockOperation, Mode, OFlags, flock, open, openat, renameat, unlinkat};
#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::{
    fs::{DirBuilder, File},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt},
    time::{Duration, UNIX_EPOCH},
};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

pub(super) const LIMIT: usize = 1_000_000;
#[cfg(unix)]
const TTL: Duration = Duration::from_secs(24 * 60 * 60);
#[cfg(unix)]
const SLOTS: u8 = 128;

#[cfg(unix)]
pub(super) fn root() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cache")))?;
    base.is_absolute()
        .then(|| base.join("herdr-gpui/avatars-v1"))
}

/// The disk cache relies on `openat`, `flock`, and POSIX ownership and mode
/// checks to keep a shared cache directory safe. Off POSIX there is no root, so
/// avatars stay in memory for the life of the process and the two accessors
/// below are unreachable.
#[cfg(not(unix))]
pub(super) fn root() -> Option<PathBuf> {
    None
}

#[cfg(not(unix))]
pub(super) fn read(_path: &Path, _url: &str, _now: SystemTime) -> Option<(Arc<Image>, bool)> {
    None
}

#[cfg(not(unix))]
pub(super) fn write(_path: &Path, _url: &str, _bytes: &[u8], _now: SystemTime) -> Option<()> {
    None
}

pub(super) fn decode(bytes: &[u8]) -> Option<Arc<Image>> {
    if bytes.is_empty() || bytes.len() > LIMIT {
        return None;
    }
    let format = image::guess_format(bytes).ok()?;
    let gpui_format = match format {
        image::ImageFormat::Png => ImageFormat::Png,
        image::ImageFormat::Jpeg => ImageFormat::Jpeg,
        image::ImageFormat::Gif => ImageFormat::Gif,
        image::ImageFormat::WebP => ImageFormat::Webp,
        _ => return None,
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(512);
    limits.max_image_height = Some(512);
    limits.max_alloc = Some(4 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().ok()?;
    if format == image::ImageFormat::Gif {
        use image::{AnimationDecoder, ImageDecoder};
        let mut decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).ok()?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(512);
        limits.max_image_height = Some(512);
        limits.max_alloc = Some(4 * 1024 * 1024);
        decoder.set_limits(limits).ok()?;
        let mut frames = decoder.into_frames();
        frames.next()?.ok()?;
        // GPUI retains every GIF frame. Avatars must not expand into an
        // unbounded animation even when their encoded file is small.
        if frames.next().is_some() {
            return None;
        }
    }
    Some(Arc::new(Image::from_bytes(gpui_format, bytes.to_vec())))
}

#[cfg(unix)]
struct Directory {
    dir: File,
    lock: File,
}

#[cfg(unix)]
impl Drop for Directory {
    fn drop(&mut self) {
        // A concurrently spawning child can briefly inherit the open description
        // before CLOEXEC takes effect. Release explicitly rather than relying on
        // the last descriptor closing in that child.
        let _ = flock(&self.lock, FlockOperation::Unlock);
    }
}

#[cfg(unix)]
impl Directory {
    fn open(path: &Path) -> Option<Self> {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .ok()?;
        let dir = File::from(
            open(
                path,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .ok()?,
        );
        let meta = dir.metadata().ok()?;
        if meta.uid() != rustix::process::geteuid().as_raw() || meta.mode() & 0o777 != 0o700 {
            return None;
        }
        let lock = File::from(
            openat(
                &dir,
                "lock",
                OFlags::RDWR
                    | OFlags::CREATE
                    | OFlags::NOFOLLOW
                    | OFlags::NONBLOCK
                    | OFlags::CLOEXEC,
                Mode::RUSR | Mode::WUSR,
            )
            .ok()?,
        );
        if !private_file(&lock) {
            return None;
        }
        // Never wait for another process; a contended cache is just a miss.
        flock(&lock, FlockOperation::NonBlockingLockExclusive).ok()?;
        Some(Self { dir, lock })
    }
}

#[cfg(unix)]
fn private_file(file: &File) -> bool {
    file.metadata().is_ok_and(|m| {
        m.is_file()
            && m.uid() == rustix::process::geteuid().as_raw()
            && m.mode() & 0o777 == 0o600
            && m.nlink() == 1
    })
}

#[cfg(unix)]
fn key(url: &str) -> ([u8; 32], String) {
    let hash: [u8; 32] = Sha256::digest(url.as_bytes()).into();
    // Fixed slots bound disk usage without walking or deleting arbitrary paths.
    (hash, format!("{:02x}.avatar", hash[0] % SLOTS))
}

#[cfg(unix)]
pub(super) fn read(path: &Path, url: &str, now: SystemTime) -> Option<(Arc<Image>, bool)> {
    let directory = Directory::open(path)?;
    let (hash, name) = key(url);
    let file = File::from(
        openat(
            &directory.dir,
            name.as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .ok()?,
    );
    if !private_file(&file) {
        return None;
    }
    let result = (|| {
        let mut bytes = Vec::new();
        file.take((LIMIT + 41) as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > LIMIT + 40 || bytes.len() < 40 {
            return None;
        }
        let image = decode(&bytes[40..])?;
        let timestamp = u64::from_le_bytes(bytes[32..40].try_into().ok()?);
        let age = now
            .duration_since(UNIX_EPOCH.checked_add(Duration::from_secs(timestamp))?)
            .ok();
        Some((bytes[..32] == hash, image, age.is_some_and(|age| age < TTL)))
    })();
    match result {
        Some((true, image, fresh)) => Some((image, fresh)),
        Some((false, _, _)) => None,
        None => {
            let _ = unlinkat(&directory.dir, name.as_str(), AtFlags::empty());
            None
        }
    }
}

#[cfg(unix)]
pub(super) fn write(path: &Path, url: &str, bytes: &[u8], now: SystemTime) -> Option<()> {
    decode(bytes)?;
    let directory = Directory::open(path)?;
    let (hash, name) = key(url);
    let timestamp = now.duration_since(UNIX_EPOCH).ok()?.as_secs();
    // One temporary entry, recovered under the lock after an interrupted write.
    let _ = unlinkat(&directory.dir, "pending", AtFlags::empty());
    let mut file = File::from(
        openat(
            &directory.dir,
            "pending",
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .ok()?,
    );
    let result = (|| {
        file.write_all(&hash).ok()?;
        file.write_all(&timestamp.to_le_bytes()).ok()?;
        file.write_all(bytes).ok()?;
        file.sync_all().ok()?;
        renameat(&directory.dir, "pending", &directory.dir, name.as_str()).ok()?;
        Some(())
    })();
    let _ = unlinkat(&directory.dir, "pending", AtFlags::empty());
    result
}

// The fixtures build a POSIX cache directory with modes and hard links.
#[cfg(all(test, unix))]
pub(super) mod tests;
