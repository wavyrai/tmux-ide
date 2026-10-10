#![allow(clippy::unwrap_used)]
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) struct Fixture(pub PathBuf);
impl Fixture {
    pub(crate) fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self(std::env::temp_dir().join(format!(
            "herdr-avatar-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub(crate) fn png() -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 2)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

#[test]
fn lock_contention_is_nonblocking_and_release_survives_inherited_descriptors() {
    let fixture = Fixture::new();
    let directory = Directory::open(&fixture.0).unwrap();
    assert!(Directory::open(&fixture.0).is_none());
    let inherited = directory.lock.try_clone().unwrap();
    drop(directory);
    assert!(Directory::open(&fixture.0).is_some());
    drop(inherited);
}

#[test]
fn persistent_roundtrip_ttl_and_collision_isolation() {
    let fixture = Fixture::new();
    let now = UNIX_EPOCH + Duration::from_secs(100_000);
    let url = "https://avatars.githubusercontent.com/u/1";
    let bytes = png();
    write(&fixture.0, url, &bytes, now).unwrap();
    assert_eq!(
        read(&fixture.0, url, now).unwrap().0.bytes.as_slice(),
        bytes.as_slice()
    );
    assert!(
        read(&fixture.0, url, now + TTL - Duration::from_secs(1))
            .unwrap()
            .1
    );
    assert!(!read(&fixture.0, url, now + TTL).unwrap().1);
    assert!(
        !read(&fixture.0, url, now - Duration::from_secs(1))
            .unwrap()
            .1
    );
    let collision = (2..10_000)
        .map(|n| format!("https://avatars.githubusercontent.com/u/{n}"))
        .find(|other| key(other).1 == key(url).1)
        .unwrap();
    assert!(read(&fixture.0, &collision, now).is_none());
    write(&fixture.0, &collision, &bytes, now).unwrap();
    assert!(read(&fixture.0, url, now).is_none());
    assert!(read(&fixture.0, &collision, now).is_some());
}

#[test]
fn corrupt_oversized_and_unsafe_entries_do_not_escape_cache() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let fixture = Fixture::new();
    let now = SystemTime::now();
    let url = "https://avatars.githubusercontent.com/u/1";
    write(&fixture.0, url, &png(), now).unwrap();
    let slot = fixture.0.join(key(url).1);
    for bytes in [b"corrupt".to_vec(), vec![0; LIMIT + 41]] {
        std::fs::write(&slot, bytes).unwrap();
        assert!(read(&fixture.0, url, now).is_none());
        assert!(!slot.exists());
        write(&fixture.0, url, &png(), now).unwrap();
    }
    let outside = fixture.0.join("untouched");
    std::fs::write(&outside, b"untouched").unwrap();
    std::fs::remove_file(&slot).unwrap();
    symlink(&outside, &slot).unwrap();
    assert!(read(&fixture.0, url, now).is_none());
    write(&fixture.0, url, &png(), now).unwrap();
    assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    assert_eq!(std::fs::metadata(&slot).unwrap().mode() & 0o777, 0o600);
    std::fs::hard_link(&slot, fixture.0.join("hardlink")).unwrap();
    assert!(read(&fixture.0, url, now).is_none());
    let linked = fixture.0.join("linked");
    symlink(&fixture.0, &linked).unwrap();
    assert!(read(&linked, url, now).is_none());
    assert!(write(&linked, url, &png(), now).is_none());
    std::fs::set_permissions(&fixture.0, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(read(&fixture.0, url, now).is_none());
    assert!(write(&fixture.0, url, &png(), now).is_none());
}

#[test]
fn quota_and_decode_limits() {
    let fixture = Fixture::new();
    let now = SystemTime::now();
    let bytes = png();
    for n in 0..300 {
        write(
            &fixture.0,
            &format!("https://avatars.githubusercontent.com/u/{n}"),
            &bytes,
            now,
        )
        .unwrap();
    }
    let entries: Vec<_> = std::fs::read_dir(&fixture.0)
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(entries.len() <= usize::from(SLOTS) + 1);
    assert!(
        entries
            .iter()
            .map(|e| e.metadata().unwrap().len())
            .sum::<u64>()
            <= 128 * (LIMIT as u64 + 40)
    );
    assert!(decode(&vec![0; LIMIT + 1]).is_none());
    assert!(decode(b"not an image").is_none());
    let mut huge = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(513, 1)
        .write_to(&mut huge, image::ImageFormat::Png)
        .unwrap();
    assert!(decode(huge.get_ref()).is_none());
    let mut animated = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut animated);
        for _ in 0..2 {
            encoder
                .encode_frame(image::Frame::new(image::RgbaImage::new(2, 2)))
                .unwrap();
        }
    }
    assert!(decode(&animated).is_none());
    assert!(write(&fixture.0, "invalid", huge.get_ref(), now).is_none());
    assert!(
        key("../../outside")
            .1
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b".avatar".contains(&b))
    );
}
