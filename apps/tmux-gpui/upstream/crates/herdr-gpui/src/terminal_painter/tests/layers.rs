use super::*;

#[gpui::test]
fn each_layer_paints_only_its_share_of_the_whole(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    cx.draw(Point::default(), size(px(800.), px(600.)), |_, _| {
        canvas(
            |_, _, _| (),
            |bounds, _, window, cx| {
                let frame = FrameData {
                    width: 3,
                    height: 1,
                    cells: vec![
                        cell("a"),
                        CellData {
                            modifier: UNDERLINE,
                            bg: 0x02123456,
                            ..cell("b")
                        },
                        cell("┼"),
                    ],
                    cursor: Some(herdr_client::protocol::CursorState {
                        x: 0,
                        y: 0,
                        visible: true,
                        shape: 0,
                    }),
                    hyperlinks: vec![],
                    graphics: vec![],
                };
                let area = whole(&frame);
                let mut painter = TerminalPainter::default();
                painter.set_appearance(21.35, 30.5, Theme::default());
                let mut paint = |part: Option<Part<'_>>| {
                    let before = *cx.default_global::<crate::performance::Counts>();
                    painter.paint_frame(
                        &frame,
                        bounds.origin,
                        None,
                        12.81,
                        &font("Menlo"),
                        &[],
                        &[],
                        part,
                        None,
                        window,
                        cx,
                    );
                    let after = *cx.default_global::<crate::performance::Counts>();
                    (
                        after.quads - before.quads,
                        after.glyphs - before.glyphs,
                        after.decorations - before.decorations,
                    )
                };
                let all = paint(None);
                let [backgrounds, text, decorations] =
                    Layer::ALL.map(|layer| paint(Some(Part { area: &area, layer })));
                assert_eq!(backgrounds.1 + backgrounds.2, 0);
                assert_eq!(text, (0, 2, 0));
                assert_eq!(decorations.1, 0);
                assert_eq!((backgrounds.0 + decorations.0, text.1, decorations.2), all);
            },
        )
        .size_full()
    });
}
