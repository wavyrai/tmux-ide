//! Families GPUI's Linux rasterizer cannot draw.
//!
//! GPUI renders non-emoji glyphs on Linux through swash with embedded bitmap
//! strikes preferred at their exact size. swash 0.2.10 panics with "chunk size
//! must be non-zero" decoding a byte-aligned EBDT mask of zero width, which is
//! how fonts such as Anonymous Pro store the space glyph in their 10-13 ppem
//! strikes (dfrg/swash#139). Until a fixed swash ships, such a family is
//! replaced rather than allowed to abort the process on the next space it draws.

/// Whether swash would panic on some glyph of face `index` in `data`: a
/// byte-aligned 1, 2, or 4 bit EBDT mask whose width is zero. Packed and
/// 8 bit masks decode without dividing rows, so they are safe at any width.
#[cfg(any(target_os = "linux", test))]
pub(super) fn has_undrawable_bitmap(data: &[u8], index: u32) -> bool {
    use skrifa::{
        FontRef, GlyphId,
        bitmap::{BitmapData, BitmapFormat, BitmapStrikes, MaskData},
        raw::TableProvider,
    };
    let Ok(font) = FontRef::from_index(data, index) else {
        return false;
    };
    let Some(strikes) = BitmapStrikes::with_format(&font, BitmapFormat::Ebdt) else {
        return false;
    };
    let glyphs = font.maxp().map_or(0, |maxp| maxp.num_glyphs());
    strikes.iter().any(|strike| {
        (0..glyphs).any(|glyph| {
            strike.get(GlyphId::from(glyph)).is_some_and(|bitmap| {
                bitmap.width == 0
                    && matches!(
                        bitmap.data,
                        BitmapData::Mask(MaskData {
                            is_packed: false,
                            bpp: 1 | 2 | 4,
                            ..
                        })
                    )
            })
        })
    })
}

/// Whether any installed face of `family` would crash the rasterizer. The
/// system font database is built once, off the UI thread, by the first
/// config resolution that asks.
#[cfg(target_os = "linux")]
pub(super) fn is_undrawable(family: &str) -> bool {
    use std::sync::OnceLock;
    static FONTS: OnceLock<fontdb::Database> = OnceLock::new();
    let fonts = FONTS.get_or_init(|| {
        let mut fonts = fontdb::Database::new();
        fonts.load_system_fonts();
        fonts
    });
    fonts
        .faces()
        .filter(|face| face.families.iter().any(|(name, _)| name == family))
        .any(|face| {
            fonts
                .with_face_data(face.id, has_undrawable_bitmap)
                .unwrap_or(false)
        })
}

/// macOS and Windows rasterize through CoreText and DirectWrite, not swash.
#[cfg(not(target_os = "linux"))]
pub(super) fn is_undrawable(_family: &str) -> bool {
    false
}
