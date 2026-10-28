#![allow(clippy::expect_used)]
use super::pixels;
#[test]
fn accepts_only_one_fixed_rgba_icon() {
    assert_eq!(
        pixels(&"ff00807f".repeat(256)),
        Some([128, 0, 255, 127].repeat(256))
    );
    for invalid in [
        "",
        "file:///tmp/icon.png",
        "https://site/icon",
        &"0".repeat(2047),
        &"g".repeat(2048),
    ] {
        assert!(pixels(invalid).is_none());
    }
}

#[test]
fn reuses_decoded_icons_and_bounds_retention() {
    use std::sync::Arc;
    super::CACHE.with(|cache| cache.borrow_mut().clear());
    let value = "ff00807f".repeat(256);
    let first = super::cached(&value).expect("valid icon");
    assert!(Arc::ptr_eq(
        &first,
        &super::cached(&value).expect("cached icon")
    ));
    for i in 0..100 {
        assert!(super::cached(&format!("{i:08x}").repeat(256)).is_some());
    }
    super::CACHE.with(|cache| assert_eq!(cache.borrow().len(), 64));
}
