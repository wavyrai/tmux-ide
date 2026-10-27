use super::*;

#[test]
fn link_underlines_stay_inside_the_frame() {
    let frame = FrameData {
        width: 10,
        height: 3,
        cells: vec![cell("a"); 30],
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    let rect = |x, y, width, height| SurfaceRect {
        x,
        y,
        width,
        height,
    };
    // A wrapped link's two rows, the second past the frame's right edge.
    assert_eq!(
        link_bounds(&frame, &[(1, 4..10), (2, 0..14)]),
        Some(rect(0, 1, 10, 2))
    );
    // Rows a resize has already removed, and empty ranges, paint nothing.
    assert_eq!(link_bounds(&frame, &[(3, 0..4), (0, 5..5)]), None);
    assert_eq!(link_bounds(&frame, &[(0, 12..14)]), None);
    assert_eq!(link_bounds(&frame, &[]), None);
}

#[gpui::test]
fn edge_backgrounds_reach_the_canvas_without_stretching_popups_or_prompts(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    for (extend, prompt) in [(false, false), (true, false), (false, true), (true, true)] {
        cx.draw(Point::default(), size(px(100.), px(100.)), |_, _| {
            canvas(
                |_, _, _| (),
                move |_, _, window, cx| {
                    let frame = FrameData {
                        width: 2,
                        height: 2,
                        cells: [0x123456, 0x654321, 0xabcdef, 0xfedcba]
                            .into_iter()
                            .enumerate()
                            .map(|(index, bg)| CellData {
                                bg: 0x02000000 | bg,
                                ..cell(if prompt && index == 3 {
                                    "\u{e0b0}"
                                } else {
                                    " "
                                })
                            })
                            .collect(),
                        cursor: None,
                        hyperlinks: vec![],
                        graphics: vec![],
                    };
                    let mut painter = TerminalPainter::default();
                    painter.set_appearance(14., 20., Theme::default());
                    painter.paint_frame(
                        &frame,
                        point(px(17.), px(23.)),
                        extend.then(|| size(px(23.), px(47.))),
                        10.,
                        &font("Menlo"),
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
        cx.update(|window, _| {
            let quads = window.painted_quads();
            let right = if extend { 13. } else { 10. };
            // A separator cap stays cell-high, so its row does not continue below.
            let bottom = if extend && !prompt { 27. } else { 20. };
            let expected = [
                (17., 23., 10., 20., 0x123456),
                (27., 23., right, 20., 0x654321),
                (17., 43., 10., bottom, 0xabcdef),
                (27., 43., right, bottom, 0xfedcba),
            ];
            assert_eq!(quads.len(), expected.len());
            for (x, y, width, height, color) in expected {
                let bounds = Bounds::new(point(px(x), px(y)), size(px(width), px(height)))
                    .scale(window.scale_factor());
                assert!(
                    quads
                        .iter()
                        .any(|quad| quad.bounds == bounds && quad.background == rgb(color).into()),
                    "extend={extend} prompt={prompt} {bounds:?}"
                );
            }
        });
    }
}

#[test]
fn backgrounds_fill_only_fractional_cell_remainders() {
    let cell = size(px(10.), px(20.));
    let available = size(px(103.), px(67.));
    let viewport = viewport(103., 67., 10., 20.);
    let grid = size(
        px(f32::from(viewport.cols) * 10.),
        px(f32::from(viewport.rows) * 20.),
    );
    assert_eq!(grid, size(px(100.), px(60.)));
    assert_eq!(background_extent(grid, available, cell), available);
    for (available, expected) in [
        (size(px(100.), px(60.)), grid),
        (size(px(99.), px(59.)), grid),
        (size(px(110.), px(80.)), grid),
        (size(px(111.), px(67.)), size(px(100.), px(67.))),
        (size(px(103.), px(81.)), size(px(103.), px(60.))),
    ] {
        assert_eq!(background_extent(grid, available, cell), expected);
    }
}

#[test]
fn decorations_cover_spaces_empty_and_wide_continuation_cells() {
    for (symbol, skip) in [("x", false), (" ", false), ("", false), ("", true)] {
        let mut cell = CellData {
            skip,
            ..cell(symbol)
        };
        assert_eq!(decoration_offsets(&cell, CELL_HEIGHT).count(), 0);
        cell.modifier = UNDERLINE;
        assert_eq!(
            decoration_offsets(&cell, CELL_HEIGHT).collect::<Vec<_>>(),
            vec![18.]
        );
        cell.modifier = STRIKETHROUGH;
        assert_eq!(
            decoration_offsets(&cell, CELL_HEIGHT).collect::<Vec<_>>(),
            vec![10.]
        );
        cell.modifier = UNDERLINE | STRIKETHROUGH;
        assert_eq!(
            decoration_offsets(&cell, CELL_HEIGHT).collect::<Vec<_>>(),
            vec![18., 10.]
        );
        assert_eq!(
            decoration_offsets(&cell, 30.5).collect::<Vec<_>>(),
            vec![28.5, 15.25]
        );
    }
}

#[cfg(feature = "integration-test")]
#[gpui::test]
fn blank_cells_paint_decorations_without_shaping(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    cx.draw(Point::default(), size(px(800.), px(600.)), |_, _| {
        canvas(
            |_, _, _| (),
            |bounds, _, window, cx| {
                let frame = FrameData {
                    width: 3,
                    height: 1,
                    cells: [(" ", false), ("", false), ("", true)]
                        .into_iter()
                        .map(|(symbol, skip)| CellData {
                            modifier: UNDERLINE | STRIKETHROUGH,
                            skip,
                            ..cell(symbol)
                        })
                        .collect(),
                    cursor: None,
                    hyperlinks: vec![],
                    graphics: vec![],
                };
                let mut painter = TerminalPainter::default();
                for (font_size, cell_height, theme) in [
                    (FONT_SIZE, CELL_HEIGHT, Theme::default()),
                    (
                        21.35,
                        30.5,
                        Theme {
                            foreground: 0xabcdef,
                            background: 0x123456,
                            ..Theme::default()
                        },
                    ),
                ] {
                    painter.set_appearance(font_size, cell_height, theme);
                    let before = cx
                        .default_global::<crate::performance::Counts>()
                        .decorations;
                    painter.paint_frame(
                        &frame,
                        bounds.origin,
                        None,
                        8.5,
                        &font("Menlo"),
                        &[],
                        &[],
                        None,
                        None,
                        window,
                        cx,
                    );
                    assert_eq!(painter.glyphs.len(), 0);
                    assert_eq!(
                        cx.default_global::<crate::performance::Counts>()
                            .decorations
                            - before,
                        6
                    );
                }
            },
        )
        .size_full()
    });
}

#[test]
fn spans_cover_skip_cells_and_resolved_colors_without_crossing_rows() {
    let theme = Theme::default();
    let mut row = vec![cell("\u{754c}"), cell(""), cell("x"), cell("x")];
    row[1].skip = true;
    row[2].fg = 0x02123456;
    row[2].modifier = 64;
    row[3].bg = 0x02123456;
    assert_eq!(
        background_spans(&row, 0..row.len(), &theme).collect::<Vec<_>>(),
        vec![(0, 2, BACKGROUND), (2, 4, 0x123456)]
    );
    assert_eq!(background_spans(&[], 0..0, &theme).count(), 0);
    for cells in row.chunks(2) {
        let expanded: Vec<_> = background_spans(cells, 0..cells.len(), &theme)
            .flat_map(|(a, b, color)| (a..b).map(move |_| color))
            .collect();
        assert_eq!(
            expanded,
            cells
                .iter()
                .map(|c| cell_colors(c, &theme).1)
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn wide_continuation_cells_take_the_glyph_background() {
    let theme = Theme::default();
    // The daemon sends continuation cells with a background of their own.
    let mut row = vec![cell("\u{3053}"), cell(""), cell("x"), cell("")];
    row[0].bg = 0x02373737;
    row[1].bg = 0x02000000;
    row[3].bg = 0x02000000;
    assert_eq!(
        background_spans(&row, 0..row.len(), &theme).collect::<Vec<_>>(),
        vec![(0, 2, 0x373737), (2, 3, BACKGROUND), (3, 4, 0)]
    );
    // Halfwidth katakana with a voiced or semi-voiced mark is two columns
    // wide in Herdr although its Unicode width is one.
    for kana in ["\u{ff76}\u{ff9e}", "\u{ff8a}\u{ff9f}"] {
        let mut row = vec![cell(kana), cell(""), cell("\u{ff76}"), cell("")];
        row[0].bg = 0x02373737;
        row[1].bg = 0x02000000;
        row[3].bg = 0x02000000;
        assert_eq!(
            background_spans(&row, 0..row.len(), &theme).collect::<Vec<_>>(),
            vec![(0, 2, 0x373737), (2, 3, BACKGROUND), (3, 4, 0)],
            "{kana}"
        );
    }
}

#[test]
fn spans_and_styles_use_custom_theme() {
    let mut theme = Theme {
        background: 0x123456,
        foreground: 0xabcdef,
        ..Theme::default()
    };
    theme.palette[200] = theme.background;
    theme.palette[1] = 0x654321;
    let row = [
        cell("x"),
        CellData {
            bg: 0x010000c8,
            fg: 2,
            ..cell("y")
        },
    ];
    assert_eq!(
        background_spans(&row, 0..row.len(), &theme).collect::<Vec<_>>(),
        vec![(0, 2, theme.background)]
    );
    assert_eq!(cell_colors(&row[0], &theme).0, theme.foreground);
    assert_eq!(cell_colors(&row[1], &theme).0, theme.palette[1]);
}

#[cfg(feature = "integration-test")]
#[gpui::test]
fn terminal_graphics_bypass_fonts_but_keep_decorations_and_skip_cells(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    cx.draw(Point::default(), size(px(800.), px(600.)), |_, _| {
        canvas(
            |_, _, _| (),
            |bounds, _, window, cx| {
                let mut frame = FrameData {
                    width: 5,
                    height: 1,
                    cells: vec![
                        CellData {
                            modifier: UNDERLINE | STRIKETHROUGH,
                            ..cell("▏")
                        },
                        CellData {
                            modifier: REVERSED,
                            ..cell("█")
                        },
                        CellData {
                            modifier: DIM,
                            ..cell("▀")
                        },
                        CellData {
                            modifier: HIDDEN,
                            ..cell("┼")
                        },
                        CellData {
                            skip: true,
                            ..cell("█")
                        },
                    ],
                    cursor: None,
                    hyperlinks: vec![],
                    graphics: vec![],
                };
                let mut painter = TerminalPainter::default();
                for family in ["Menlo", "Courier"] {
                    painter.set_appearance(21.35, 30.5, Theme::default());
                    let before = *cx.default_global::<crate::performance::Counts>();
                    painter.paint_frame(
                        &frame,
                        bounds.origin,
                        None,
                        12.81,
                        &font(family),
                        &[],
                        &[],
                        None,
                        None,
                        window,
                        cx,
                    );
                    let after = cx.default_global::<crate::performance::Counts>();
                    assert_eq!(painter.glyphs.len(), 0);
                    assert_eq!(after.shapes, before.shapes);
                    assert_eq!(after.glyphs, before.glyphs);
                    assert_eq!(after.decorations - before.decorations, 2);
                    let backgrounds =
                        background_spans(&frame.cells, 0..frame.cells.len(), &painter.theme)
                            .count();
                    assert_eq!(after.quads - before.quads, backgrounds + 7);
                }
                frame.cells[0] = cell("a");
                painter.paint_frame(
                    &frame,
                    bounds.origin,
                    None,
                    12.81,
                    &font("Menlo"),
                    &[],
                    &[],
                    None,
                    None,
                    window,
                    cx,
                );
                assert_eq!(
                    painter.glyphs.len(),
                    1,
                    "ordinary text still uses the glyph cache"
                );
            },
        )
        .size_full()
    });
}
