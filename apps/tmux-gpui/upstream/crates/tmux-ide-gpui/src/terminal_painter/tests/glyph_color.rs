use super::*;

/// The run memo hands back exactly the colour a fresh conversion would,
/// including after the colour changes and changes back.
#[test]
fn a_glyph_colour_run_converts_like_a_fresh_conversion() {
    let mut memo = GlyphColor::default();
    for color in [
        0x00_0000, 0x00_0000, 0xff_ffff, 0x40_a0ff, 0x40_a0ff, 0x00_0000, 0xc0_ffee,
    ] {
        assert_eq!(memo.get(color), Hsla::from(rgb(color)), "{color:06x}");
    }
}
