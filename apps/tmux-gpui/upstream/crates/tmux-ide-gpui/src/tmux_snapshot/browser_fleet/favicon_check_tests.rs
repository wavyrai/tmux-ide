#![allow(clippy::unwrap_used)]
//! #719: favicons are judged by their header before anything decodes them.
use super::super::favicon;
use base64::{Engine as _, engine::general_purpose::STANDARD};

fn decoded(mime: &str, bytes: &[u8]) -> bool {
    favicon(mime, &STANDARD.encode(bytes)).is_some()
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    b.extend(width.to_be_bytes());
    b.extend(height.to_be_bytes());
    b.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
    b
}

/// A GIF with the given screen and `frames` frames of `fw`×`fh` each.
fn gif(width: u16, height: u16, frames: usize, fw: u16, fh: u16) -> Vec<u8> {
    let mut b = b"GIF89a".to_vec();
    b.extend(width.to_le_bytes());
    b.extend(height.to_le_bytes());
    b.extend([0, 0, 0]);
    for _ in 0..frames {
        b.push(0x2c);
        b.extend([0, 0, 0, 0]);
        b.extend(fw.to_le_bytes());
        b.extend(fh.to_le_bytes());
        b.push(0);
        b.extend([2, 2, 0x4c, 0x01, 0]);
    }
    b.push(0x3b);
    b
}

fn jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut b = vec![0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8];
    b.extend(height.to_be_bytes());
    b.extend(width.to_be_bytes());
    b.extend([1, 1, 0x11, 0, 0xff, 0xda]);
    b
}

fn webp_vp8x(width: u32, height: u32) -> Vec<u8> {
    let mut b = b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00".to_vec();
    b.extend(&(width - 1).to_le_bytes()[..3]);
    b.extend(&(height - 1).to_le_bytes()[..3]);
    b
}

/// An icon directory with one entry holding `data`.
fn ico(data: &[u8]) -> Vec<u8> {
    let mut b = vec![0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0];
    b.extend((data.len() as u32).to_le_bytes());
    b.extend(22u32.to_le_bytes());
    b.extend(data);
    b
}

fn bmp_header(width: i32, height: i32) -> Vec<u8> {
    let mut b = 40u32.to_le_bytes().to_vec();
    b.extend(width.to_le_bytes());
    b.extend((height * 2).to_le_bytes());
    b.extend([1, 0, 32, 0]);
    b.extend([0; 24]);
    b
}

#[test]
fn small_files_declaring_huge_images_are_refused_before_decoding() {
    assert!(!decoded("image/png", &png(30_000, 30_000)));
    assert!(!decoded("image/gif", &gif(30_000, 30_000, 1, 1, 1)));
    assert!(!decoded("image/jpeg", &jpeg(30_000, 30_000)));
    assert!(!decoded("image/webp", &webp_vp8x(30_000, 30_000)));
    // An icon directory may claim 16×16 while its PNG entry declares 30000×30000.
    assert!(!decoded("image/x-icon", &ico(&png(30_000, 30_000))));
    assert!(!decoded("image/x-icon", &ico(&bmp_header(30_000, 30_000))));
    // Every GIF frame decodes to the full screen: 2000 frames of 32×32.
    assert!(!decoded("image/gif", &gif(32, 32, 2000, 32, 32)));
    // A frame larger than its screen.
    assert!(!decoded("image/gif", &gif(16, 16, 1, 30_000, 30_000)));
}

#[test]
fn an_svg_referring_outside_itself_is_refused() {
    let wrap = |inner: &str| {
        format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">{inner}</svg>"#)
    };
    for inner in [
        r#"<image href="/etc/passwd" width="16" height="16"/>"#,
        r#"<image xlink:href='file:///Users/x/secret.png' width="16" height="16"/>"#,
        r#"<image href = "icon.png"/>"#,
        r#"<image href="data:image/png;base64,iVBORw0KGgo="/>"#,
        r#"<image href="https://example.com/a.png"/>"#,
        r#"<rect style="fill: url(other.svg#paint)" width="1" height="1"/>"#,
        r#"<style>@import "x.css";</style>"#,
    ] {
        assert!(!decoded("image/svg+xml", wrap(inner).as_bytes()), "{inner}");
    }
    assert!(!decoded(
        "image/svg+xml",
        br#"<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>"#
    ));
}

#[test]
fn an_svg_declaring_a_huge_canvas_is_refused() {
    for svg in [
        r#"<svg width="8192" height="8192"/>"#,
        r#"<svg viewBox="0 0 30000 30000"/>"#,
        r#"<svg width="16" viewBox="0 0 1 100000"/>"#,
        r#"<svg width="100in" height="100in"/>"#,
        r#"<svg width="huge" height="16"/>"#,
    ] {
        assert!(!decoded("image/svg+xml", svg.as_bytes()), "{svg}");
    }
}

#[test]
fn ordinary_favicons_still_decode() {
    assert!(decoded("image/png", &png(16, 16)));
    assert!(decoded("image/png", &png(512, 512)));
    assert!(decoded("image/gif", &gif(16, 16, 3, 16, 16)));
    assert!(decoded("image/jpeg", &jpeg(180, 180)));
    assert!(decoded("image/webp", &webp_vp8x(192, 192)));
    assert!(decoded("image/x-icon", &ico(&bmp_header(16, 16))));
    assert!(decoded("image/x-icon", &ico(&png(256, 256))));
    assert!(decoded("image/svg+xml", b"<svg/>"));
    assert!(decoded(
        "image/svg+xml",
        br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g"/></defs><use href="#g"/><rect fill="url(#g)" width="512" height="512"/></svg>"##
    ));
}

#[test]
fn truncated_headers_are_refused() {
    for (mime, bytes) in [
        ("image/png", png(16, 16)[..20].to_vec()),
        ("image/gif", gif(16, 16, 1, 16, 16)[..12].to_vec()),
        ("image/jpeg", jpeg(16, 16)[..10].to_vec()),
        ("image/webp", webp_vp8x(16, 16)[..26].to_vec()),
        ("image/x-icon", ico(&png(16, 16))[..30].to_vec()),
    ] {
        assert!(!decoded(mime, &bytes), "{mime}");
    }
}
