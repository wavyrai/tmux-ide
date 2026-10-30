#![allow(clippy::unwrap_used)]
use super::*;

fn frames() -> (FrameData, NativeFrame) {
    let cells = vec![
        CellData {
            bg: 0x02123456,
            ..cell("界")
        },
        CellData {
            bg: 0x02654321,
            skip: true,
            modifier: UNDERLINE,
            ..cell("")
        },
        CellData {
            bg: 0x02abcdef,
            ..cell(" ")
        },
        cell("a"),
        cell("b"),
        cell("c"),
    ];
    let flat = FrameData {
        cells,
        width: 3,
        height: 2,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    let native = NativeFrame {
        rows: flat
            .cells
            .chunks(3)
            .map(|r| Arc::from(r.to_vec()))
            .collect(),
        width: 3,
        height: 2,
        cursor: None,
    };
    (flat, native)
}
#[test]
fn borrowed_rows_share_storage_and_match_flat_cell_access() {
    let (flat, native) = frames();
    let a = FrameView::Flat(&flat);
    let b = FrameView::Rows(&native);
    for y in 0..3 {
        assert_eq!(a.row(y), b.row(y));
    }
    for i in 0..8 {
        assert_eq!(a.cell_at(i), b.cell_at(i));
    }
    assert!(std::ptr::eq(
        b.row(0).unwrap().as_ptr(),
        native.rows[0].as_ptr()
    ));
    assert!(std::ptr::eq(b.cell_at(1).unwrap(), &native.rows[0][1]));
    assert!(b.cell_at(1).unwrap().skip);
}
#[test]
fn missing_or_overlong_native_rows_never_escape_geometry() {
    let native = NativeFrame {
        width: 2,
        height: 3,
        rows: vec![Arc::from(vec![cell("x"); 4]), Arc::from(vec![cell("y")])],
        cursor: None,
    };
    let view = FrameView::Rows(&native);
    assert_eq!(view.row(0).unwrap().len(), 2);
    assert_eq!(view.row(1).unwrap().len(), 1);
    assert!(view.row(2).is_none());
    assert!(view.cell_at(3).is_none());
    assert_eq!(
        cell_ranges(&native, &whole(&native)).collect::<Vec<_>>(),
        vec![0..2, 2..3]
    );
    let empty = NativeFrame {
        width: 0,
        height: 1,
        rows: vec![Arc::from(vec![cell("x")])],
        cursor: None,
    };
    assert!(FrameView::Rows(&empty).cell_at(0).is_none());
}
#[gpui::test]
fn native_and_flat_clipped_backgrounds_and_selection_paint_identically(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    let mut painted = Vec::new();
    for native in [false, true] {
        cx.draw(Point::default(), size(px(100.), px(100.)), |_, _| {
            canvas(
                |_, _, _| (),
                move |_, _, window, cx| {
                    let (flat, rows) = frames();
                    let area = [
                        Span {
                            row: 0,
                            columns: 1..3,
                        },
                        Span {
                            row: 1,
                            columns: 0..2,
                        },
                    ];
                    let highlights = [Highlight {
                        row: 0,
                        columns: 0..3,
                        tint: Tint::Selection,
                    }];
                    let mut painter = TerminalPainter::default();
                    painter.set_appearance(14., 20., Theme::default());
                    let view = if native {
                        FrameView::Rows(&rows)
                    } else {
                        FrameView::Flat(&flat)
                    };
                    painter.paint_view(
                        view,
                        point(px(10.), px(10.)),
                        None,
                        10.,
                        &font("Menlo"),
                        &highlights,
                        &[],
                        Some(Part {
                            area: &area,
                            layer: Layer::Backgrounds,
                        }),
                        None,
                        window,
                        cx,
                    );
                },
            )
            .size_full()
        });
        painted.push(cx.update(|window, _| {
            window
                .painted_quads()
                .iter()
                .map(|q| (q.bounds, q.background))
                .collect::<Vec<_>>()
        }));
    }
    assert!(!painted[0].is_empty());
    assert_eq!(painted[0], painted[1]);
}
