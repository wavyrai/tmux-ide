#![allow(clippy::unwrap_used)]
use super::*;

/// A PNG header declaring `width`×`height`: admission reads only the header.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bytes.extend(width.to_be_bytes());
    bytes.extend(height.to_be_bytes());
    bytes.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

#[test]
fn only_admissible_images_reach_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>"#;
    let (Asset::Ready(path), pixels) = store(dir.path(), ImageMime::Svg, svg, PIXEL_BUDGET) else {
        panic!("svg refused")
    };
    assert!(path.starts_with(dir.path()));
    assert_eq!(pixels, 40 * 20);
    assert_eq!(std::fs::read(&path).unwrap(), svg);
    // An SVG that asks for another file, or bytes that are not the declared type.
    let fetching = br#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="4" height="4"><image href="file:///etc/passwd" width="4" height="4"/></svg>"#;
    assert_eq!(
        store(dir.path(), ImageMime::Svg, fetching, PIXEL_BUDGET).0,
        Asset::Refused
    );
    assert_eq!(
        store(dir.path(), ImageMime::Png, b"not a png", PIXEL_BUDGET).0,
        Asset::Refused
    );
}

/// Review round 1, item 4 and R16: each picture is capped at 8192 a side and
/// 16 M pixels, and a document's pictures share a 64 M pixel budget.
#[test]
fn pictures_are_capped_each_and_by_the_documents_budget() {
    let dir = tempfile::tempdir().unwrap();
    for (w, h) in [(8193, 1), (1, 8193), (4097, 4096)] {
        assert_eq!(
            store(dir.path(), ImageMime::Png, &png(w, h), PIXEL_BUDGET).0,
            Asset::Refused,
            "{w}x{h}"
        );
    }
    let (asset, pixels) = store(dir.path(), ImageMime::Png, &png(4096, 4096), PIXEL_BUDGET);
    assert!(matches!(asset, Asset::Ready(_)));
    assert_eq!(pixels, 4096 * 4096);
    // Four of the largest fill the budget; a fifth is too large to show.
    let mut left = PIXEL_BUDGET;
    for _ in 0..4 {
        let (asset, pixels) = store(dir.path(), ImageMime::Png, &png(4096, 4096), left);
        assert!(matches!(asset, Asset::Ready(_)));
        left -= pixels;
    }
    assert_eq!(
        store(dir.path(), ImageMime::Png, &png(4096, 4096), left).0,
        Asset::TooLarge
    );
    assert!(matches!(
        store(dir.path(), ImageMime::Png, &png(16, 16), PIXEL_BUDGET).0,
        Asset::Ready(_)
    ));
}

#[test]
fn the_work_thread_parses_renders_and_stores_in_order() {
    let kitchen = Kitchen::spawn().unwrap();
    assert!(kitchen.send(Job::Parse {
        pane: "pane-a".into(),
        revision: "r".into(),
        bytes: b"# Hi\n\n![a](images/a.png)\n".to_vec(),
    }));
    let done = loop {
        if let Some(done) = kitchen.poll() {
            break done;
        }
        std::thread::yield_now();
    };
    let Done::Parsed { doc, lossy, .. } = done else {
        panic!("parsed first")
    };
    assert!(!lossy);
    assert!(kitchen.send(Job::Render {
        pane: "pane-a".into(),
        ticket: 3,
        doc,
        assets: BTreeMap::new(),
    }));
    let done = loop {
        if let Some(done) = kitchen.poll() {
            break done;
        }
        std::thread::yield_now();
    };
    let Done::Rendered { ticket, wanted, .. } = done else {
        panic!("rendered")
    };
    assert_eq!(ticket, 3);
    assert_eq!(wanted, ["images/a.png"]);
}

/// Timing for the review (run with --release --ignored): a 4 MiB document.
#[test]
#[ignore = "timing, run by hand"]
fn time_a_4_mib_document() {
    let mut source = String::new();
    while source.len() < 4 * 1024 * 1024 {
        source.push_str("## Section\n\nSome **text** with `code` and a [link](https://x.dev).\n\n- item\n- [ ] task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![p](img/p.png)\n\n");
    }
    let started = std::time::Instant::now();
    let (doc, _) = parse(source.as_bytes());
    let parsed = started.elapsed();
    let started = std::time::Instant::now();
    let _ = policy::rewrite(&doc, &BTreeMap::new());
    eprintln!(
        "TIMING {} bytes, {} blocks: parse {parsed:?}, rewrite {:?}",
        source.len(),
        doc.blocks.len(),
        started.elapsed()
    );
}
