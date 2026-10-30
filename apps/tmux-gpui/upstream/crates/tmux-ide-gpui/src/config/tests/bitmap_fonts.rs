use super::*;
use crate::config::bitmap_fonts::has_undrawable_bitmap;

/// A one-glyph font whose only table besides `maxp` is a 10 ppem EBLC/EBDT
/// strike holding glyph 0 as a small-metrics bitmap in `image_format` (1 is
/// byte-aligned, 2 bit-aligned), `width` pixels wide and one row tall.
fn strike_font(image_format: u16, bit_depth: u8, width: u8) -> Vec<u8> {
    let row_bytes = (usize::from(width) * usize::from(bit_depth)).div_ceil(8);
    // Small glyph metrics: height, width, bearingX, bearingY, advance.
    let mut glyph = vec![1, width, 0, 1, width.max(1)];
    glyph.resize(glyph.len() + row_bytes, 0xff);

    let mut ebdt = vec![0, 2, 0, 0];
    ebdt.extend_from_slice(&glyph);

    let mut eblc = Vec::new();
    eblc.extend_from_slice(&[0, 2, 0, 0]);
    eblc.extend_from_slice(&1u32.to_be_bytes());
    // BitmapSize: subtable list at 56, 24 bytes long, one subtable.
    eblc.extend_from_slice(&56u32.to_be_bytes());
    eblc.extend_from_slice(&24u32.to_be_bytes());
    eblc.extend_from_slice(&1u32.to_be_bytes());
    eblc.extend_from_slice(&0u32.to_be_bytes());
    eblc.extend_from_slice(&[0; 24]);
    eblc.extend_from_slice(&[0, 0, 0, 0, 10, 10, bit_depth, 1]);
    // IndexSubtableRecord for glyphs 0..=0, its subtable 8 bytes on.
    eblc.extend_from_slice(&[0, 0, 0, 0]);
    eblc.extend_from_slice(&8u32.to_be_bytes());
    // Format 1 subtable: image data starts after EBDT's header.
    eblc.extend_from_slice(&1u16.to_be_bytes());
    eblc.extend_from_slice(&image_format.to_be_bytes());
    eblc.extend_from_slice(&4u32.to_be_bytes());
    eblc.extend_from_slice(&0u32.to_be_bytes());
    eblc.extend_from_slice(&(glyph.len() as u32).to_be_bytes());

    let maxp = [0, 0, 0x50, 0, 0, 1].to_vec();
    sfnt(&[(*b"EBDT", ebdt), (*b"EBLC", eblc), (*b"maxp", maxp)])
}

/// Packs tables, already sorted by tag, behind an sfnt table directory.
fn sfnt(tables: &[([u8; 4], Vec<u8>)]) -> Vec<u8> {
    let mut font = Vec::new();
    font.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    font.extend_from_slice(&(tables.len() as u16).to_be_bytes());
    font.extend_from_slice(&[0; 6]);
    let mut offset = 12 + 16 * tables.len();
    for (tag, data) in tables {
        font.extend_from_slice(tag);
        font.extend_from_slice(&0u32.to_be_bytes());
        font.extend_from_slice(&(offset as u32).to_be_bytes());
        font.extend_from_slice(&(data.len() as u32).to_be_bytes());
        offset += data.len().next_multiple_of(4);
    }
    for (_, data) in tables {
        font.extend_from_slice(data);
        font.resize(font.len().next_multiple_of(4), 0);
    }
    font
}

#[test]
fn zero_width_byte_aligned_bitmaps_are_undrawable() {
    for bit_depth in [1, 2, 4] {
        assert!(has_undrawable_bitmap(&strike_font(1, bit_depth, 0), 0));
    }
}

#[test]
fn drawable_bitmaps_and_outline_fonts_pass() {
    assert!(!has_undrawable_bitmap(&strike_font(1, 1, 3), 0));
    // Bit-aligned and 8 bit masks decode without a row stride.
    assert!(!has_undrawable_bitmap(&strike_font(2, 1, 0), 0));
    assert!(!has_undrawable_bitmap(&strike_font(1, 8, 0), 0));
    assert!(!has_undrawable_bitmap(
        &sfnt(&[(*b"maxp", vec![0, 0, 0x50, 0, 0, 1])]),
        0
    ));
    assert!(!has_undrawable_bitmap(b"not a font", 0));
}

#[test]
fn undrawable_families_fall_back_to_each_face_default() {
    let defaults = Config::default();
    let mut config = Config::default();
    config.terminal.family = "Anonymous Pro".into();
    config.ui.family = "Anonymous Pro".into();
    config.sidebar.family = "Iosevka".into();
    config.replace_undrawable_fonts(|family| family == "Anonymous Pro");
    assert_eq!(config.terminal.family, defaults.terminal.family);
    assert_eq!(config.ui.family, defaults.ui.family);
    assert_eq!(config.sidebar.family, "Iosevka");
}
