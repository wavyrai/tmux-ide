use super::*;

#[test]
fn composition_stays_at_the_cursor_inside_the_grid() {
    let grid = Bounds::new(point(px(10.), px(20.)), size(px(100.), px(40.)));
    let cursor = point(px(30.), px(40.));
    assert_eq!(composition_origin(cursor, px(50.), grid), cursor);
    assert_eq!(
        composition_origin(point(px(90.), px(40.)), px(50.), grid),
        point(px(60.), px(40.)),
        "shifted left just enough to end at the grid's edge"
    );
    assert_eq!(
        composition_origin(cursor, px(200.), grid),
        point(px(-90.), px(40.)),
        "wider than the grid, it keeps its end, where the IME edits"
    );
}

#[test]
fn composition_ranges_count_utf16_units() {
    let text = "a\u{304b}\u{1f600}b";
    assert_eq!(
        [0, 1, 2, 3, 4, 5, 6].map(|utf16| byte_index(text, utf16)),
        [0, 1, 4, 8, 8, 9, 9]
    );
    assert_eq!(byte_index("", 1), 0);
}

#[gpui::test]
fn composition_bounds_follow_the_converted_clause(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    cx.draw(Point::default(), size(px(800.), px(600.)), |_, _| {
        canvas(
            |_, _, _| (),
            |bounds, _, window, cx| {
                let mut painter = TerminalPainter::default();
                let font = font("Menlo");
                let cell_width = painter.cell_width(&font, window, cx);
                let cursor = Bounds::new(
                    bounds.origin + point(px(cell_width * 4.), px(CELL_HEIGHT)),
                    size(px(cell_width), px(CELL_HEIGHT)),
                );
                // Romaji mid-composition: the headless text system gives
                // CJK glyphs next to no advance, which would hide the
                // right-edge geometry. UTF-16 mapping is tested separately.
                let text = "kan";
                let bounds_of = |range, cursor| {
                    painter.composition_bounds(text, range, cursor, bounds, &font, window)
                };
                assert_eq!(
                    painter.composition_bounds("", 0..0, cursor, bounds, &font, window),
                    cursor,
                    "without a composition the IME anchors at the cursor"
                );
                let first = bounds_of(0..1, cursor);
                let second = bounds_of(1..2, cursor);
                let caret = bounds_of(3..3, cursor);
                assert_eq!(first.origin, cursor.origin);
                assert_eq!(second.origin.y, cursor.origin.y);
                assert!(second.origin.x > first.origin.x);
                assert!(caret.origin.x > second.origin.x);
                assert_eq!(caret.size, cursor.size);
                // At the right edge the text, and so every clause, shifts left.
                let edge = Bounds::new(
                    point(bounds.right() - px(cell_width), cursor.origin.y),
                    cursor.size,
                );
                let end = bounds_of(3..3, edge);
                assert_eq!(end.right(), bounds.right(), "the caret stays inside");
                assert_eq!(end.size, cursor.size);
                assert!(bounds_of(0..1, edge).origin.x < edge.origin.x);
                // Wider than the grid, the start scrolls off the left while
                // every clause still anchors inside the grid.
                let long = "k".repeat(200);
                let long_bounds =
                    |range| painter.composition_bounds(&long, range, cursor, bounds, &font, window);
                assert_eq!(long_bounds(0..1).origin.x, bounds.left());
                assert_eq!(long_bounds(200..200).right(), bounds.right());
            },
        )
        .size_full()
    });
}
