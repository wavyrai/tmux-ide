//! Families GPUI's Linux rasterizer cannot draw.
//!
//! GPUI renders non-emoji glyphs on Linux through swash with embedded bitmap
//! strikes preferred at their exact size. swash 0.2.10 panics with "chunk size
//! must be non-zero" decoding a byte-aligned EBDT mask of zero width, which is
//! how fonts such as Anonymous Pro store the space glyph in their 10-13 ppem
//! strikes (dfrg/swash#139). Until a fixed swash ships, such a family is
//! replaced rather than allowed to abort the process on the next space it draws.

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
