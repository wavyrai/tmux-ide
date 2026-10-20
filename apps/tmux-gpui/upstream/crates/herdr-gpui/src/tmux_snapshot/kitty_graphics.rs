//! tmux-ide SPIKE: kitty graphics protocol placements for the snapshot preview.
//!
//! The daemon projects kitty images onto the replica's `placements` (kind
//! `kitty-image`, id `kitty:<image>:<srcRow>:<srcCol>:<totalRows>:<totalCols>`
//! naming the visible sub-rectangle) and ships image bytes in a `kittyImages`
//! side-table keyed by content digest. This maps both onto the painter's
//! existing graphics scene so `terminal_painter/images.rs` does the rest.
use super::Error;
use herdr_client::{
    SurfaceImages,
    protocol::{
        SurfaceGraphicsAsset, SurfaceGraphicsAssetKey, SurfaceGraphicsFormat,
        SurfaceGraphicsPlacement, SurfaceGraphicsSource, SurfaceGraphicsTarget,
    },
};
use serde::Deserialize;
use std::collections::HashMap;

pub(super) struct Graphics {
    pub(super) placements: Vec<SurfaceGraphicsPlacement>,
    pub(super) images: SurfaceImages,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Placement {
    id: String,
    kind: String,
    row: u16,
    column: u16,
    columns: u32,
    rows: u32,
    content_digest: String,
}

#[derive(Deserialize)]
struct Image {
    digest: String,
    format: String,
    width: u32,
    height: u32,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    #[serde(default)]
    placements: Vec<Placement>,
    #[serde(default)]
    kitty_images: Vec<Image>,
}

/// Graphics for one snapshot, or None when it places no kitty images.
pub(super) fn graphics(bytes: &[u8], pane_id: &str) -> Result<Option<Graphics>, Error> {
    let envelope: Envelope = serde_json::from_slice(bytes)?;
    let mut keys = HashMap::new();
    let mut assets = Vec::new();
    for (index, image) in envelope.kitty_images.into_iter().enumerate() {
        let format = match image.format.as_str() {
            "png" => SurfaceGraphicsFormat::Png,
            "rgba" => SurfaceGraphicsFormat::Rgba,
            "rgb" => SurfaceGraphicsFormat::Rgb,
            _ => return Err(Error::Invalid("unknown kitty image format")),
        };
        let data = base64(&image.data).ok_or(Error::Invalid("kitty image data is not base64"))?;
        let key = SurfaceGraphicsAssetKey {
            source: SurfaceGraphicsSource::Terminal {
                target: SurfaceGraphicsTarget::Pane {
                    pane_id: pane_id.to_owned(),
                },
                image_id: u32::try_from(index).unwrap_or(u32::MAX),
            },
            image_width: image.width,
            image_height: image.height,
            format,
            data_len: data.len() as u64,
            data_fingerprint: fingerprint(&image.digest),
        };
        keys.insert(image.digest, key.clone());
        assets.push(SurfaceGraphicsAsset { key, data });
    }
    let mut placements = Vec::new();
    for (index, placement) in envelope.placements.into_iter().enumerate() {
        if placement.kind != "kitty-image" {
            continue;
        }
        let Some(key) = keys.get(&placement.content_digest) else {
            continue;
        };
        let parts: Vec<u32> = placement
            .id
            .strip_prefix("kitty:")
            .ok_or(Error::Invalid("kitty placement id"))?
            .split(':')
            .map(str::parse)
            .collect::<Result<_, _>>()
            .map_err(|_| Error::Invalid("kitty placement id"))?;
        let [_, src_row, src_col, total_rows, total_cols] = parts[..] else {
            return Err(Error::Invalid("kitty placement id"));
        };
        if total_rows == 0 || total_cols == 0 {
            return Err(Error::Invalid("kitty placement id"));
        }
        // Each cell shows 1/total of the image; scale the cell rectangle into pixels.
        let scale = |cells: u32, total: u32, side: u32| {
            (u64::from(cells) * u64::from(side) / u64::from(total)) as u32
        };
        placements.push(SurfaceGraphicsPlacement {
            asset: key.clone(),
            logical_placement_id: u32::try_from(index).unwrap_or(u32::MAX),
            x: placement.column,
            y: placement.row,
            cols: placement.columns,
            rows: placement.rows,
            source_x: scale(src_col, total_cols, key.image_width),
            source_y: scale(src_row, total_rows, key.image_height),
            source_width: scale(placement.columns, total_cols, key.image_width).max(1),
            source_height: scale(placement.rows, total_rows, key.image_height).max(1),
            x_offset: 0,
            y_offset: 0,
            z: 0,
            scrollback_offset: 0,
        });
    }
    if placements.is_empty() {
        return Ok(None);
    }
    Ok(Some(Graphics {
        placements,
        images: assets.into_iter().collect(),
    }))
}

fn fingerprint(digest: &str) -> u64 {
    u64::from_str_radix(digest.get(..16).unwrap_or(digest), 16).unwrap_or(0)
}

/// Minimal standard-alphabet base64 decoder (spike: avoids a new dependency edge).
fn base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let bytes = text.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in bytes {
        acc = (acc << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
#[path = "kitty_graphics_tests.rs"]
mod tests;
