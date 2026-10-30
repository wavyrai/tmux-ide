use super::*;

mod bitmap_fonts;
mod default_fonts;
mod fonts;

#[test]
fn defaults_use_the_platform_faces_at_their_sizes() {
    let config = Config::default();
    let super::fonts::DefaultFonts {
        monospace, sans, ..
    } = super::fonts::PLATFORM_FONTS;
    for (font, family, size) in [
        (&config.sidebar, monospace, 12.0),
        (&config.tabs, monospace, 12.0),
        (&config.terminal, monospace, 14.0),
        (&config.ui, sans, 12.0),
    ] {
        assert_eq!(font.family, family);
        assert_eq!(font.size, size);
        assert!(FONT_SIZE_RANGE.contains(&font.size));
        assert_eq!(font.fallbacks, None);
    }
    assert_eq!(config.terminal.line_height(), 20.0);
}
