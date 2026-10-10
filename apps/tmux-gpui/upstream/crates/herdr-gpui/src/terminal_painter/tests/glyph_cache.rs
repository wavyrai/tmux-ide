use super::*;

#[test]
fn cache_style_is_the_font_face_alone() {
    // Color, dim, reverse, hidden and grid decorations are painted, not shaped.
    for modifier in [0, 2, 8, 64, 128, 256, 2 | 64 | 128 | 256] {
        assert_eq!(glyphs::style(modifier), 0, "{modifier}");
    }
    let styles = [BOLD, ITALIC, BOLD | ITALIC].map(glyphs::style);
    assert_eq!(styles, [1, 2, 3]);
    for style in 0..4 {
        assert_eq!(glyphs::style(glyphs::style_modifier(style)), style);
    }
}

#[gpui::test]
fn cache_reuses_cells_invalidates_fonts_and_bounds_storage(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    let painter = std::rc::Rc::new(std::cell::RefCell::new(TerminalPainter::default()));
    let frame = FrameData {
        width: 5,
        height: 1,
        cells: vec![
            cell("x"),
            cell("x"),
            cell("e\u{301}"),
            cell("\u{754c}"),
            CellData {
                skip: true,
                ..cell("")
            },
        ],
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    let mut draw = |frame: FrameData, font: Font| {
        let painter = painter.clone();
        cx.draw(Point::default(), size(px(800.), px(600.)), |_, _| {
            canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    let cell_width = painter.borrow_mut().cell_width(&font, window, cx);
                    painter.borrow_mut().paint_frame(
                        &frame,
                        bounds.origin,
                        None,
                        cell_width,
                        &font,
                        &[],
                        &[],
                        None,
                        None,
                        window,
                        cx,
                    );
                },
            )
            .size_full()
        });
    };
    draw(frame.clone(), font("Menlo"));
    assert_eq!(painter.borrow().glyphs.len(), 3);
    let original_width = painter.borrow().cell_width.unwrap_or_default();
    painter
        .borrow_mut()
        .set_appearance(FONT_SIZE, CELL_HEIGHT, Theme::default());
    assert_eq!(
        painter.borrow().glyphs.len(),
        3,
        "unchanged appearance retains glyphs"
    );
    assert_eq!(painter.borrow().cell_width, Some(original_width));
    let mut theme = Theme::default();
    for (font_size, cell_height) in [(28., CELL_HEIGHT), (28., 36.), (28., 36.)] {
        // The final iteration changes only the palette.
        if painter.borrow().cell_height == 36. {
            theme.palette[1] = 0x123456;
        }
        painter
            .borrow_mut()
            .set_appearance(font_size, cell_height, theme.clone());
        assert_eq!(painter.borrow().glyphs.len(), 0);
        assert!(painter.borrow().cell_width.is_none());
        draw(frame.clone(), font("Menlo"));
        assert_eq!(painter.borrow().glyphs.len(), 3);
        assert!(painter.borrow().cell_width.unwrap_or_default() > original_width * 1.5);
        let painter = painter.borrow();
        for (_, _, line) in painter.glyphs.iter() {
            assert_eq!(line.font_size, px(font_size));
        }
    }
    painter
        .borrow_mut()
        .set_appearance(FONT_SIZE, CELL_HEIGHT, Theme::default());
    draw(frame.clone(), font("Menlo"));
    assert_eq!(painter.borrow().glyphs.len(), 3);
    let mut changed = frame.clone();
    changed.cells[0].fg = 0x02123456;
    changed.cells[1].modifier = 1 | 4;
    draw(changed, font("Menlo"));
    assert_eq!(
        painter.borrow().glyphs.len(),
        4,
        "a new color reuses the glyph; only bold italic shapes again"
    );
    draw(frame.clone(), font("Courier"));
    assert_eq!(
        painter.borrow().glyphs.len(),
        3,
        "new font discards old glyphs"
    );
    // A changed icon cascade reshapes every cell: the same family can now
    // resolve Private Use Area glyphs a text face does not carry.
    let with_fallbacks = |families: &[&str]| {
        crate::config::FontConfig {
            family: "Courier".into(),
            size: FONT_SIZE,
            fallbacks: Some(families.iter().map(|family| (*family).to_owned()).collect()),
            line_height_multiple: None,
        }
        .font()
    };
    let cascaded = with_fallbacks(&["Symbols Nerd Font Mono"]);
    assert_ne!(cascaded, font("Courier"));
    draw(frame.clone(), cascaded.clone());
    assert_eq!(
        painter.borrow().glyphs.len(),
        3,
        "an added cascade discards old glyphs"
    );
    assert_eq!(painter.borrow().config.as_ref(), Some(&cascaded));
    draw(frame.clone(), with_fallbacks(&["Hack Nerd Font Mono"]));
    assert_eq!(
        painter.borrow().glyphs.len(),
        3,
        "a reordered cascade discards old glyphs"
    );
    draw(frame, font("Courier"));
    let colors = FrameData {
        width: 100,
        height: 50,
        cells: (0..5000)
            .map(|i| CellData {
                fg: 0x02000000 | i,
                ..cell("x")
            })
            .collect(),
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    draw(colors, font("Menlo"));
    assert_eq!(
        painter.borrow().glyphs.len(),
        1,
        "truecolor output shares one glyph"
    );
    let symbols = FrameData {
        width: 100,
        height: 50,
        cells: (0..5000)
            .filter_map(|i| char::from_u32(0x4e00 + i))
            .map(|symbol| cell(&symbol.to_string()))
            .collect(),
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    draw(symbols, font("Menlo"));
    assert_eq!(painter.borrow().glyphs.len(), glyphs::CACHE_LIMIT);
    assert_eq!(painter.borrow().glyphs.iter().count(), glyphs::CACHE_LIMIT);
}
