//! Inline fixed-size pixels: no network requests or file access during rendering.
use gpui::{prelude::*, *};
use std::{cell::RefCell, collections::VecDeque, sync::Arc};
thread_local! {
    static CACHE: RefCell<VecDeque<(String, Arc<RenderImage>)>> = const { RefCell::new(VecDeque::new()) };
}
fn cached(value: &str) -> Option<Arc<RenderImage>> {
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some((_, image)) = cache.iter().find(|(key, _)| key == value) {
            return Some(image.clone());
        }
        let pixels = image::RgbaImage::from_raw(16, 16, pixels(value)?)?;
        let image = Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]));
        if cache.len() == 64 {
            cache.pop_front();
        }
        cache.push_back((value.into(), image.clone()));
        Some(image)
    })
}

fn pixels(value: &str) -> Option<Vec<u8>> {
    if value.len() != 2048
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut bytes: Vec<u8> = value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect::<Option<_>>()?;
    // GPUI uploads BGRA textures; the metadata remains renderer-neutral RGBA.
    for pixel in bytes.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(bytes)
}
pub(in crate::tmux_snapshot) fn element(
    value: Option<&str>,
    fallback: &'static str,
    size: f32,
    tint: u32,
) -> AnyElement {
    if let Some(image) = value.and_then(cached) {
        return img(image).size(px(size)).flex_none().into_any_element();
    }
    svg()
        .path(if value.is_some() {
            "icons/globe.svg"
        } else {
            fallback
        })
        .size(px(size))
        .flex_none()
        .text_color(rgb(tint))
        .into_any_element()
}
#[cfg(test)]
#[path = "browser_icon_tests.rs"]
mod tests;
