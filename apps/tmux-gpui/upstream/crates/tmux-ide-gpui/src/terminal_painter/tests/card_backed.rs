use super::*;

/// #746 v3: on a card, a cell on the default background shows the card;
/// every other background, reverse video, the selection tint and the
/// cursor still paint.
#[gpui::test]
fn a_card_shows_through_only_the_default_background(cx: &mut TestAppContext) {
    let theme = Theme::default();
    let explicit = 0x123456;
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    for card_backed in [false, true] {
        let painted = theme.clone();
        cx.draw(Point::default(), size(px(200.), px(100.)), move |_, _| {
            let theme = painted.clone();
            canvas(
                |_, _, _| (),
                move |_, _, window, cx| {
                    let frame = FrameData {
                        width: 5,
                        height: 1,
                        cells: vec![
                            // Default background.
                            cell("a"),
                            // An explicit background.
                            CellData {
                                bg: 0x02000000 | explicit,
                                ..cell("b")
                            },
                            // Reverse video: the foreground becomes the background.
                            CellData {
                                modifier: REVERSED,
                                ..cell("c")
                            },
                            // A program's own background equal to the theme's.
                            CellData {
                                bg: 0x02000000 | theme.background,
                                ..cell("d")
                            },
                            cell("e"),
                        ],
                        cursor: Some(herdr_client::protocol::CursorState {
                            x: 4,
                            y: 0,
                            visible: true,
                            shape: 0,
                        }),
                        hyperlinks: vec![],
                        graphics: vec![],
                    };
                    let mut painter = TerminalPainter::default();
                    painter.set_appearance(14., 20., theme.clone());
                    painter.set_card_backed(card_backed);
                    painter.paint_frame(
                        &frame,
                        point(px(0.), px(0.)),
                        None,
                        10.,
                        &font("Menlo"),
                        &[Highlight {
                            row: 0,
                            columns: 0..2,
                            tint: Tint::Selection,
                        }],
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
            // What paints from a cell's left edge (a span may cover more).
            let at = |x: f32| {
                let cell = Bounds::new(point(px(x), px(0.)), size(px(10.), px(20.)))
                    .scale(window.scale_factor());
                quads
                    .iter()
                    .filter(|q| q.bounds.origin == cell.origin)
                    .map(|q| q.background)
                    .collect::<Vec<_>>()
            };
            let bg: Background = rgb(theme.background).into();
            let fg: Background = rgb(theme.foreground).into();
            // The default background paints only off a card.
            assert_eq!(
                at(0.).contains(&bg),
                !card_backed,
                "card_backed={card_backed}"
            );
            // An explicit background and reverse video always paint.
            assert!(at(10.).contains(&rgb(explicit).into()));
            assert!(at(20.).contains(&fg));
            // A program's background equal to the theme's is the default's
            // colour, so on a card it shows the card too.
            assert_eq!(at(30.).contains(&bg), !card_backed);
            // The selection tint over the first two cells still paints.
            let tint: Background = Tint::Selection.color(&theme).into();
            assert!(quads.iter().any(|q| q.background == tint));
            // So does the cursor.
            assert!(!at(40.).is_empty(), "cursor, card_backed={card_backed}");
        });
    }
}
