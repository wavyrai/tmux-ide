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

#[test]
fn wheel_remainder_keeps_fractions_and_resets_on_reversal() {
    let mut wheel = WheelRemainder::default();
    assert_eq!(wheel.add(0.4), 0);
    assert_eq!(wheel.add(0.7), 1);
    // The 0.1 left over is dropped when the direction reverses.
    assert_eq!(wheel.add(-0.5), 0);
    assert_eq!(wheel.add(-0.6), -1);
    assert_eq!(wheel.add(f32::NAN), 0);
    assert_eq!(wheel.add(f32::INFINITY), 0);
    // One event's work is bounded, not a backlog.
    assert_eq!(wheel.add(10_000.), 128);
    assert_eq!(wheel.add(0.), 0);
}

#[test]
fn selection_copies_are_capped_at_four_mebibytes() {
    assert_eq!(MAX_SELECTION_BYTES, 4 << 20);
}

fn text_cells(text: &str) -> Vec<CellData> {
    text.chars()
        .map(|c| CellData {
            symbol: c.to_string(),
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
            hyperlink: None,
        })
        .collect()
}

#[test]
fn logical_web_links_resolve_plain_and_explicit_links_but_not_hidden_cells() {
    let mut cells = text_cells("see https://a.test/x now");
    let row: Vec<&CellData> = cells.iter().collect();
    assert_eq!(
        logical_web_link(&row, 8, &[]).as_deref(),
        Some("https://a.test/x")
    );
    assert_eq!(logical_web_link(&row, 0, &[]), None);
    cells[0].hyperlink = Some(0);
    let row: Vec<&CellData> = cells.iter().collect();
    let hyperlinks = ["https://b.test/".to_owned()];
    assert_eq!(
        logical_web_link(&row, 0, &hyperlinks).as_deref(),
        Some("https://b.test/")
    );
    let local = ["file:///etc/passwd".to_owned()];
    assert_eq!(logical_web_link(&row, 0, &local), None);
    cells[8].modifier |= HIDDEN;
    let row: Vec<&CellData> = cells.iter().collect();
    assert_eq!(logical_web_link(&row, 8, &[]), None);
    let long = text_cells(&"x".repeat(8193));
    let row: Vec<&CellData> = long.iter().collect();
    assert_eq!(logical_web_link(&row, 0, &[]), None);
}
