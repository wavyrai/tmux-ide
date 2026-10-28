use super::*;
use gpui::size;

mod separators;

fn rectangles(symbol: &str, cell: Bounds<Pixels>, scale: f32) -> Vec<Bounds<Pixels>> {
    let mut result = Vec::new();
    let Some(graphic) = Graphic::from_symbol(symbol) else {
        panic!("unsupported fixture {symbol}");
    };
    graphic.rectangles(cell, scale, |rect| result.push(rect));
    result
}

fn covered(rects: &[Bounds<Pixels>], x: f32, y: f32) -> bool {
    rects
        .iter()
        .any(|r| px(x) >= r.left() && px(x) < r.right() && px(y) >= r.top() && px(y) < r.bottom())
}

#[test]
fn input_border_has_no_row_gaps_at_fractional_sizes_and_scales() {
    for scale in [1., 1.25, 1.5, 2., 3.] {
        for (width, height) in [(8., 20.), (8.53, 20.7), (12.81, 30.5)] {
            for symbol in ["▏", "▎", "│", "┃", "█"] {
                let mut all = Vec::new();
                let origin = point(px(3.27), px(7.13));
                for row in 0..10 {
                    all.extend(rectangles(
                        symbol,
                        Bounds::new(
                            origin + point(px(0.), px(row as f32 * height)),
                            size(px(width), px(height)),
                        ),
                        scale,
                    ));
                }
                let x = f32::from(all[0].left()) + 0.5 / scale;
                let start = (f32::from(origin.y) * scale).round() as i32;
                let end = ((f32::from(origin.y) + 10. * height) * scale).round() as i32;
                for y in start..end {
                    assert!(
                        covered(&all, x, (y as f32 + 0.5) / scale),
                        "gap in {symbol} at pixel {y}, scale {scale}, height {height}"
                    );
                }
            }
        }
    }
}

#[test]
fn horizontal_strokes_have_no_column_gaps() {
    for scale in [1., 1.25, 1.5, 2., 3.] {
        for symbol in ["─", "━", "▀", "▁", "█"] {
            let mut all = Vec::new();
            for col in 0..10 {
                all.extend(rectangles(
                    symbol,
                    Bounds::new(
                        point(px(3.27 + col as f32 * 8.53), px(7.13)),
                        size(px(8.53), px(20.7)),
                    ),
                    scale,
                ));
            }
            let y = f32::from(all[0].top()) + 0.5 / scale;
            let start = (3.27 * scale).round() as i32;
            let end = ((3.27 + 10. * 8.53) * scale).round() as i32;
            for x in start..end {
                assert!(
                    covered(&all, (x as f32 + 0.5) / scale, y),
                    "gap in {symbol} at {x}, scale {scale}"
                );
            }
        }
    }
}

#[test]
fn block_complements_tile_without_gaps_or_overlap() {
    for scale in [1., 1.25, 2., 3.] {
        let cell = Bounds::new(point(px(3.27), px(7.13)), size(px(8.53), px(20.7)));
        let full = rectangles("█", cell, scale);
        for symbols in [["▀", "▄"], ["▌", "▐"], ["▛", "▗"], ["▚", "▞"], ["▙", "▝"]]
        {
            let first = rectangles(symbols[0], cell, scale);
            let second = rectangles(symbols[1], cell, scale);
            for y in 0..80 {
                for x in 0..40 {
                    let x = (x as f32 + 0.5) / scale;
                    let y = (y as f32 + 0.5) / scale;
                    let a = covered(&first, x, y);
                    let b = covered(&second, x, y);
                    assert!(!(a && b), "overlap in {symbols:?}");
                    assert_eq!(a || b, covered(&full, x, y), "gap in {symbols:?}");
                }
            }
        }
    }
}

#[test]
fn box_corners_tees_and_mixed_weights_join() {
    let cell = Bounds::new(point(px(0.), px(0.)), size(px(8.), px(16.)));
    // Independent pixel masks, including the center of a mixed-weight joint.
    for (symbol, rows) in [
        ("┌", ["........", "...#####", "...#....", "...#...."]),
        ("┘", ["...#....", "####....", "........", "........"]),
        ("┼", ["...#....", "########", "...#....", "...#...."]),
        ("┝", ["...#....", "...#####", "...#####", "...#...."]),
        ("╋", ["...##...", "########", "########", "...##..."]),
    ] {
        let rects = rectangles(symbol, cell, 1.);
        for (row, y) in [0.5, 7.5, 8.5, 15.5].into_iter().enumerate() {
            for (x, expected) in rows[row].chars().enumerate() {
                assert_eq!(
                    covered(&rects, x as f32 + 0.5, y),
                    expected == '#',
                    "{symbol} at {x}, {y}"
                );
            }
        }
    }
}

#[test]
fn graphics_are_bounded_and_pixel_aligned() {
    for code in 0x2500..=0x259f {
        let Some(ch) = char::from_u32(code) else {
            continue;
        };
        let Some(graphic) = Graphic::from_symbol(&ch.to_string()) else {
            continue;
        };
        for scale in [1., 1.25, 1.5, 2., 3.] {
            let cell = Bounds::new(point(px(3.27), px(7.13)), size(px(8.53), px(20.7)));
            let full = rectangles("█", cell, scale)[0];
            let mut count = 0;
            graphic.rectangles(cell, scale, |r| {
                count += 1;
                let device = |edge: Pixels| (f32::from(edge) * scale).round();
                assert!(
                    device(r.left()) >= device(full.left())
                        && device(r.right()) <= device(full.right()),
                    "{ch} at {scale}: {r:?}"
                );
                assert!(
                    device(r.top()) >= device(full.top())
                        && device(r.bottom()) <= device(full.bottom()),
                    "{ch} at {scale}: {r:?}"
                );
                for edge in [r.left(), r.right(), r.top(), r.bottom()] {
                    let device = f32::from(edge) * scale;
                    assert!((device - device.round()).abs() < 0.0001);
                }
            });
            assert!((1..=4).contains(&count));
        }
    }
}

#[test]
fn ordinary_text_and_unsupported_graphics_keep_font_shaping() {
    for symbol in [
        "",
        "a",
        "界",
        "─\u{301}",
        "█\u{fe0f}",
        "██",
        "╭",
        "╱",
        "═",
        "┆",
        "░",
        "▒",
        "▓",
    ] {
        assert!(Graphic::from_symbol(symbol).is_none(), "{symbol:?}");
    }
    for code in (0x250c..=0x254b)
        .chain(0x2574..=0x2590)
        .chain(0x2594..=0x259f)
    {
        if let Some(ch) = char::from_u32(code) {
            assert!(Graphic::from_symbol(&ch.to_string()).is_some(), "{ch}");
        }
    }
}
