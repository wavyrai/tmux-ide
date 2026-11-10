#![allow(clippy::unwrap_used)]
use super::*;

const REV: &str = "0123456789abcdef0123456789abcdef";

fn chunk(offset: u64, bytes: &[u8], revision: &str) -> ReaderChunk {
    ReaderChunk {
        revision: revision.into(),
        size: 10,
        offset,
        bytes: bytes.to_vec(),
    }
}

#[test]
fn pages_reassemble_in_order_and_a_gap_restarts_the_read() {
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    let whole = assemble(Some(first), chunk(5, b"world", REV)).unwrap();
    assert_eq!(whole.bytes, b"helloworld");
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    assert!(assemble(Some(first), chunk(6, b"orld", REV)).is_none());
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    assert!(assemble(Some(first), chunk(5, b"world", &"f".repeat(32))).is_none());
    assert!(assemble(None, chunk(5, b"world", REV)).is_none());
}

#[test]
fn the_next_page_resumes_where_the_held_bytes_end() {
    let held = Progress {
        revision: REV.into(),
        bytes: vec![0; 7],
    };
    assert_eq!(
        page_of(Some(&held)),
        Some(ReaderPage {
            revision: REV.into(),
            offset: 7
        })
    );
}

#[test]
fn only_admissible_images_reach_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>"#;
    let Asset::Ready(path) = store(dir.path(), ImageMime::Svg, svg) else {
        panic!("svg refused")
    };
    assert!(path.starts_with(dir.path()));
    assert_eq!(std::fs::read(&path).unwrap(), svg);
    // An SVG that asks for another file, or bytes that are not the declared type.
    let fetching = br#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="4" height="4"><image href="file:///etc/passwd" width="4" height="4"/></svg>"#;
    assert_eq!(store(dir.path(), ImageMime::Svg, fetching), Asset::Refused);
    assert_eq!(
        store(dir.path(), ImageMime::Png, b"not a png"),
        Asset::Refused
    );
}
