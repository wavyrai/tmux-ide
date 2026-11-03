//! What a favicon declares, read from its header before anything decodes it
//! (#719). A file under 32 KiB can still declare 30000×30000 pixels, a GIF can
//! carry thousands of frames, and an SVG can make the renderer read another
//! file. Anything malformed, oversized or referring outside itself is refused,
//! and Home shows its terminal glyph instead.
use gpui::ImageFormat;

/// The largest side Home decodes; real favicons are 16–512 px.
pub(super) const MAX_SIDE: u64 = 1024;
/// The decoded pixels allowed in total, GIF frames included (about 4 MB RGBA).
pub(super) const MAX_PIXELS: u64 = MAX_SIDE * MAX_SIDE;

pub(super) fn admissible(format: ImageFormat, bytes: &[u8]) -> bool {
    let pixels = match format {
        ImageFormat::Png => png(bytes).map(|(w, h)| (w, h, 1)),
        ImageFormat::Gif => gif(bytes),
        ImageFormat::Jpeg => jpeg(bytes).map(|(w, h)| (w, h, 1)),
        ImageFormat::Webp => webp(bytes).map(|(w, h)| (w, h, 1)),
        ImageFormat::Ico => ico(bytes).map(|(w, h)| (w, h, 1)),
        ImageFormat::Svg => svg(bytes).map(|(w, h)| (w, h, 1)),
        _ => None,
    };
    pixels.is_some_and(|(w, h, frames)| {
        w > 0
            && h > 0
            && w <= MAX_SIDE
            && h <= MAX_SIDE
            && w.saturating_mul(h).saturating_mul(frames) <= MAX_PIXELS
    })
}

fn be32(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u32::from_be_bytes(
        b.get(at..at + 4)?.try_into().ok()?,
    )))
}
fn le16(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u16::from_le_bytes(
        b.get(at..at + 2)?.try_into().ok()?,
    )))
}
fn le24(b: &[u8], at: usize) -> Option<u64> {
    let s = b.get(at..at + 3)?;
    Some(u64::from(s[0]) | u64::from(s[1]) << 8 | u64::from(s[2]) << 16)
}
fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn png(b: &[u8]) -> Option<(u64, u64)> {
    if !b.starts_with(PNG_SIGNATURE) || b.get(12..16)? != b"IHDR" {
        return None;
    }
    Some((be32(b, 16)?, be32(b, 20)?))
}

/// Logical screen, every frame's size and the frame count; each decoded frame
/// fills the whole screen.
fn gif(b: &[u8]) -> Option<(u64, u64, u64)> {
    if !(b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) {
        return None;
    }
    let (w, h) = (le16(b, 6)?, le16(b, 8)?);
    let flags = *b.get(10)?;
    let mut at = 13
        + if flags & 0x80 != 0 {
            3 << ((flags & 7) + 1)
        } else {
            0
        };
    let skip_sub_blocks = |mut at: usize| -> Option<usize> {
        loop {
            let len = usize::from(*b.get(at)?);
            at += 1;
            if len == 0 {
                return Some(at);
            }
            at += len;
        }
    };
    let mut frames = 0u64;
    loop {
        match *b.get(at)? {
            0x3b => break,
            0x21 => at = skip_sub_blocks(at + 2)?,
            0x2c => {
                let (fw, fh) = (le16(b, at + 5)?, le16(b, at + 7)?);
                if fw > MAX_SIDE || fh > MAX_SIDE {
                    return None;
                }
                let local = *b.get(at + 9)?;
                at += 10
                    + if local & 0x80 != 0 {
                        3 << ((local & 7) + 1)
                    } else {
                        0
                    };
                at = skip_sub_blocks(at + 1)?;
                frames += 1;
            }
            _ => return None,
        }
    }
    (frames > 0).then_some((w, h, frames))
}

/// The first start-of-frame marker before the scan data.
fn jpeg(b: &[u8]) -> Option<(u64, u64)> {
    if !b.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut at = 2;
    loop {
        if *b.get(at)? != 0xff {
            return None;
        }
        let mut marker = *b.get(at + 1)?;
        while marker == 0xff {
            at += 1;
            marker = *b.get(at + 1)?;
        }
        at += 2;
        if (0xd0..=0xd7).contains(&marker) || marker == 0x01 {
            continue;
        }
        if marker == 0xd9 || marker == 0xda {
            return None;
        }
        let length = usize::from(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?));
        if matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
            let height = u64::from(u16::from_be_bytes(b.get(at + 3..at + 5)?.try_into().ok()?));
            let width = u64::from(u16::from_be_bytes(b.get(at + 5..at + 7)?.try_into().ok()?));
            return Some((width, height));
        }
        if length < 2 {
            return None;
        }
        at += length;
    }
}

fn webp(b: &[u8]) -> Option<(u64, u64)> {
    if b.get(0..4)? != b"RIFF" || b.get(8..12)? != b"WEBP" {
        return None;
    }
    match b.get(12..16)? {
        b"VP8 " => {
            if b.get(23..26)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            Some((le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff))
        }
        b"VP8L" => {
            if *b.get(20)? != 0x2f {
                return None;
            }
            let bits = u64::from(le32(b, 21)?);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8X" => Some((le24(b, 24)? + 1, le24(b, 27)? + 1)),
        _ => None,
    }
}

/// The largest image in the directory, read from each entry's own data: a PNG
/// entry declares its size in its header, not in the directory.
fn ico(b: &[u8]) -> Option<(u64, u64)> {
    if le16(b, 0)? != 0 || !matches!(le16(b, 2)?, 1 | 2) {
        return None;
    }
    let count = usize::try_from(le16(b, 4)?).ok()?;
    if count == 0 || count > 64 {
        return None;
    }
    let mut largest = (0, 0);
    for entry in 0..count {
        let at = 6 + entry * 16;
        let size = usize::try_from(le32(b, at + 8)?).ok()?;
        let offset = usize::try_from(le32(b, at + 12)?).ok()?;
        let data = b.get(offset..offset.checked_add(size)?)?;
        let (w, h) = if data.starts_with(PNG_SIGNATURE) {
            png(data)?
        } else {
            // BITMAPINFOHEADER: an icon's height counts the mask rows too.
            if le32(data, 0)? < 40 {
                return None;
            }
            let w = i64::from(le32(data, 4)? as i32).unsigned_abs();
            let h = i64::from(le32(data, 8)? as i32).unsigned_abs() / 2;
            (w, h)
        };
        if w > MAX_SIDE || h > MAX_SIDE {
            return None;
        }
        largest = (largest.0.max(w), largest.1.max(h));
    }
    Some(largest)
}

/// The size the renderer rasterizes at (its declared width and height, or
/// its viewBox), and only references inside the document itself.
fn svg(b: &[u8]) -> Option<(u64, u64)> {
    let text = std::str::from_utf8(b).ok()?.to_ascii_lowercase();
    // No DTD (entities), no imported style sheets.
    if text.contains("<!doctype") || text.contains("<!entity") || text.contains("@import") {
        return None;
    }
    // Every href (and xlink:href) and every CSS url() must point inside the
    // document: a file path, URL or data: image would be loaded and decoded.
    for (at, _) in text.match_indices("href") {
        let rest = text[at + 4..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        let value = rest
            .trim_start()
            .trim_start_matches(['"', '\''])
            .trim_start();
        if !value.starts_with('#') {
            return None;
        }
    }
    for (at, _) in text.match_indices("url(") {
        let value = text[at + 4..]
            .trim_start()
            .trim_start_matches(['"', '\''])
            .trim_start();
        if !value.starts_with('#') {
            return None;
        }
    }
    let start = text.match_indices("<svg").map(|(at, _)| at).find(|&at| {
        text[at + 4..].starts_with(|c: char| c.is_whitespace() || c == '>' || c == '/')
    })?;
    let tag = &text[start..start + text[start..].find('>')?];
    let attribute = |name: &str| -> Option<&str> {
        let mut search = 0;
        while let Some(found) = tag[search..].find(name) {
            let at = search + found;
            search = at + name.len();
            if !tag[..at].ends_with(|c: char| c.is_whitespace()) {
                continue;
            }
            let rest = tag[search..].trim_start().strip_prefix('=')?.trim_start();
            let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let value = &rest[1..];
            return Some(&value[..value.find(quote)?]);
        }
        None
    };
    let length = |name: &str| -> Option<Option<f64>> {
        let Some(value) = attribute(name) else {
            return Some(None);
        };
        let value = value.trim();
        if value.ends_with('%') {
            return Some(None);
        }
        let units = [
            ("px", 1.0),
            ("pt", 4.0 / 3.0),
            ("pc", 16.0),
            ("mm", 96.0 / 25.4),
            ("cm", 96.0 / 2.54),
            ("in", 96.0),
            ("em", 16.0),
            ("ex", 8.0),
        ];
        let (number, scale) = units
            .iter()
            .find_map(|(unit, scale)| value.strip_suffix(unit).map(|n| (n, *scale)))
            .unwrap_or((value, 1.0));
        let number: f64 = number.trim().parse().ok()?;
        (number.is_finite() && number >= 0.0).then_some(Some(number * scale))
    };
    let (width, height) = (length("width")?, length("height")?);
    let view_box = match attribute("viewbox") {
        Some(value) => {
            let numbers: Vec<f64> = value
                .split(|c: char| c.is_whitespace() || c == ',')
                .filter(|s| !s.is_empty())
                .map(str::parse)
                .collect::<Result<_, _>>()
                .ok()?;
            let [_, _, w, h] = numbers[..] else {
                return None;
            };
            (w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0).then_some((w, h))?;
            Some((w, h))
        }
        None => None,
    };
    // The renderer's own rules: a missing side follows the viewBox's aspect;
    // with neither, the document is 100×100.
    let (w, h) = match (width, height, view_box) {
        (Some(w), Some(h), _) => (w, h),
        (Some(w), None, Some((vw, vh))) => (w, w * vh / vw),
        (None, Some(h), Some((vw, vh))) => (h * vw / vh, h),
        (None, None, Some((vw, vh))) => (vw, vh),
        (Some(w), None, None) => (w, 100.0),
        (None, Some(h), None) => (100.0, h),
        (None, None, None) => (100.0, 100.0),
    };
    if !(w.is_finite() && h.is_finite()) || w > MAX_SIDE as f64 || h > MAX_SIDE as f64 {
        return None;
    }
    Some((w.ceil().max(1.0) as u64, h.ceil().max(1.0) as u64))
}

#[cfg(test)]
#[path = "favicon_check_tests.rs"]
mod tests;
