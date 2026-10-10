//! Captures part of a page as it looks on screen, for a note's screenshot.
//!
//! This is the one place the app calls WebKit directly, and it needs
//! `unsafe`: `WKWebView.takeSnapshotWithConfiguration:completionHandler:`
//! and `WKSnapshotConfiguration` have no safe binding in `objc2-web-kit`, and
//! wry offers no screenshot of its own. The alternatives were a screen capture
//! through macOS, which needs Screen Recording permission and captures
//! whatever covers the window, or re-rendering the page in script, which
//! misses images, canvases, and cross-origin content. Everything after the
//! capture, turning the image into PNG, is safe code.
#![allow(unsafe_code)]

use super::annotate::Rect;
use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_app_kit::NSImage;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::NSError;
use objc2_web_kit::WKSnapshotConfiguration;
use std::cell::Cell;
use wry::WebViewExtMacOS as _;

/// Longest side of a saved screenshot, in pixels.
const MAX_SIDE: u32 = 2000;

/// Asks WebKit for `rect`, in CSS pixels of the page's viewport, and calls
/// `done` with the image's TIFF bytes, or `None` when WebKit has none. WebKit
/// answers on the main thread after the page's next screen update, so the
/// annotation overlay hidden before this call is not in the picture.
pub(crate) fn capture(
    view: &wry::WebView,
    rect: Rect,
    done: impl FnOnce(Option<Vec<u8>>) + 'static,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        done(None);
        return;
    };
    let webview = view.webview();
    // SAFETY: `new` requires the main thread, which `mtm` proves.
    let configuration = unsafe { WKSnapshotConfiguration::new(mtm) };
    let area = CGRect::new(
        CGPoint::new(rect.x, rect.y),
        CGSize::new(rect.width, rect.height),
    );
    // SAFETY: plain property setters on a configuration this function owns,
    // on the main thread. The rectangle is in the web view's own flipped
    // coordinates, which are the viewport's CSS pixels at the default zoom.
    unsafe {
        configuration.setRect(area);
        configuration.setAfterScreenUpdates(true);
    }
    // WebKit calls the handler once; the cell turns `done` into the `Fn` a
    // block must be.
    let done = Cell::new(Some(done));
    let handler = RcBlock::new(move |image: *mut NSImage, _: *mut NSError| {
        // SAFETY: WebKit passes either null or a valid `NSImage` it keeps
        // alive for the duration of this call; the reference does not escape.
        let image = unsafe { image.as_ref() };
        let tiff = image
            .and_then(NSImage::TIFFRepresentation)
            .map(|data| data.to_vec());
        if let Some(done) = done.take() {
            done(tiff);
        }
    });
    // SAFETY: called on the main thread with a configuration that stays
    // alive for the call, and a heap block WebKit retains until it has run.
    unsafe {
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &handler);
    }
}

/// A capture as PNG, scaled down to at most `MAX_SIDE` pixels a side.
/// Decoding is work for a background thread.
pub(crate) fn png(tiff: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory_with_format(tiff, image::ImageFormat::Tiff).ok()?;
    let image = if image.width().max(image.height()) > MAX_SIDE {
        image.resize(MAX_SIDE, MAX_SIDE, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
    Some(bytes.into_inner())
}

/// A capture decoded into a frame GPUI paints as is, with no loading of its
/// own: a picture handed to `img` as encoded bytes is decoded on its first
/// frame, and a page stepping aside for it would leave that frame empty.
/// Decoding is work for a background thread.
pub(crate) fn frame(tiff: &[u8]) -> Option<gpui::RenderImage> {
    let image = image::load_from_memory_with_format(tiff, image::ImageFormat::Tiff).ok()?;
    let mut pixels = image.into_rgba8();
    // GPUI keeps pictures as BGRA.
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(gpui::RenderImage::new(vec![image::Frame::new(pixels)]))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn tiff(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Tiff)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn captures_become_bounded_pngs() {
        let small = png(&tiff(40, 20)).unwrap();
        let decoded = image::load_from_memory(&small).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (40, 20));
        let large = image::load_from_memory(&png(&tiff(4000, 1000)).unwrap()).unwrap();
        assert_eq!((large.width(), large.height()), (MAX_SIDE, MAX_SIDE / 4));
        assert!(png(b"not a tiff").is_none());
    }

    #[test]
    fn captures_become_paintable_bgra_frames() {
        let frame = frame(&tiff(3, 2)).unwrap();
        let size = frame.size(0);
        assert_eq!((size.width.0, size.height.0), (3, 2));
        // The red and blue channels trade places.
        assert_eq!(&frame.as_bytes(0).unwrap()[..4], &[30, 20, 10, 255]);
        assert!(super::frame(b"not a tiff").is_none());
    }
}
