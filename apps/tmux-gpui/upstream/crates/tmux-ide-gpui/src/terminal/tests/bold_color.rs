use super::*;

#[test]
fn bold_color_applies_to_default_foreground_only() {
    let theme = Theme {
        foreground: 0x999999,
        bold: Some(0xffffff),
        ..Theme::default()
    };
    let mut cell = CellData {
        symbol: "x".into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    };
    assert_eq!(cell_colors(&cell, &theme).0, 0x999999);
    cell.modifier = BOLD;
    assert_eq!(cell_colors(&cell, &theme).0, 0xffffff);
    // Named, indexed and RGB foregrounds are the program's choice.
    for fg in [2, 0x010000c8, 0x02123456] {
        cell.fg = fg;
        assert_eq!(
            cell_colors(&cell, &theme).0,
            color(fg, 0, &theme),
            "{fg:#x}"
        );
    }
}

#[test]
fn bold_color_follows_reverse_and_dim_like_any_foreground() {
    let theme = Theme {
        foreground: 0x999999,
        background: 0x000000,
        bold: Some(0xffffff),
        ..Theme::default()
    };
    let mut cell = CellData {
        symbol: "x".into(),
        fg: 0,
        bg: 0,
        modifier: BOLD | REVERSED,
        skip: false,
        hyperlink: None,
    };
    assert_eq!(cell_colors(&cell, &theme), (0x000000, 0xffffff));
    cell.modifier = BOLD | DIM;
    assert_eq!(cell_colors(&cell, &theme).0, 0x7f7f7f);
}

#[test]
fn bold_text_keeps_the_foreground_without_a_bold_color() {
    let theme = Theme {
        foreground: 0x999999,
        bold: None,
        ..Theme::default()
    };
    let cell = CellData {
        symbol: "x".into(),
        fg: 0,
        bg: 0,
        modifier: BOLD,
        skip: false,
        hyperlink: None,
    };
    assert_eq!(cell_colors(&cell, &theme).0, 0x999999);
}
