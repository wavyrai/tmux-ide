use super::*;

mod bold_color;

#[test]
fn wire_colors_are_not_argb() {
    let theme = Theme::default();
    assert_eq!(color(0, FOREGROUND, &theme), FOREGROUND);
    assert_eq!(color(0, BACKGROUND, &theme), BACKGROUND);
    for (i, expected) in theme.palette[..16].iter().enumerate() {
        assert_eq!(color(i as u32 + 1, 0, &theme), *expected);
        assert_eq!(color(0x01000000 | i as u32, 0, &theme), *expected);
    }
    assert_eq!(color(0x02123456, 0, &theme), 0x123456);
    assert_eq!(color(0x01000010, 1, &theme), 0);
    assert_eq!(color(0x01000015, 0, &theme), 0x0000ff);
    assert_eq!(color(0x010000e7, 0, &theme), 0xffffff);
    assert_eq!(color(0x010000e8, 0, &theme), 0x080808);
    assert_eq!(color(0x010000ff, 0, &theme), 0xeeeeee);
    assert_eq!(color(0xff000000, 42, &theme), 42);
}

#[test]
fn reverse_and_hidden_colors() {
    let mut cell = CellData {
        symbol: "x".into(),
        fg: 0x02ff0000,
        bg: 0x020000ff,
        modifier: 1 << 6,
        skip: false,
        hyperlink: None,
    };
    assert_eq!(cell_colors(&cell, &Theme::default()), (0x0000ff, 0xff0000));
    cell.modifier |= 1 << 7;
    assert_eq!(cell_colors(&cell, &Theme::default()), (0xff0000, 0xff0000));
}

#[test]
fn custom_palette_and_defaults_preserve_truecolor_and_modifiers() {
    let mut theme = Theme {
        foreground: 0xabcdef,
        background: 0x123456,
        ..Theme::default()
    };
    for (i, entry) in theme.palette.iter_mut().enumerate() {
        *entry = 0x654300 + i as u32;
    }
    for i in 0..256 {
        assert_eq!(color(0x01000000 | i, 0, &theme), theme.palette[i as usize]);
        if i < 16 {
            assert_eq!(color(i + 1, 0, &theme), theme.palette[i as usize]);
        }
    }
    let mut cell = CellData {
        symbol: "x".into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    };
    assert_eq!(
        cell_colors(&cell, &theme),
        (theme.foreground, theme.background)
    );
    cell.fg = 0x02123456;
    cell.bg = 0x010000ff;
    assert_eq!(cell_colors(&cell, &theme), (0x123456, theme.palette[255]));
    cell.modifier = 1 << 6;
    assert_eq!(cell_colors(&cell, &theme), (theme.palette[255], 0x123456));
    cell.modifier |= 1 << 1;
    assert_eq!(
        cell_colors(&cell, &theme).0,
        ((theme.palette[255] & 0xfefefe) >> 1) + ((0x123456 & 0xfefefe) >> 1)
    );
}
