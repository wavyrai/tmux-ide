use super::*;

#[test]
fn separator_shapes_reach_the_cell_edges_at_fractional_sizes() -> anyhow::Result<()> {
    for (symbol, shape) in [
        ("\u{e0b0}", CellSeparator::RightTriangle),
        ("\u{e0b2}", CellSeparator::LeftTriangle),
        ("\u{e0b4}", CellSeparator::RightRound),
        ("\u{e0b6}", CellSeparator::LeftRound),
    ] {
        assert_eq!(CellSeparator::from_symbol(symbol), Some(shape));
        assert!(Graphic::from_symbol(symbol).is_none());
        // The painter passes snapped corners; the path keeps them exactly.
        for (top_left, bottom_right) in [
            (point(px(3.25), px(7.5)), point(px(26.), px(58.75))),
            (point(px(0.5), px(20.5)), point(px(10.5), px(40.5))),
        ] {
            let path = shape.path(top_left, bottom_right)?;
            assert_eq!(path.bounds.origin, top_left, "{symbol}");
            assert_eq!(
                path.bounds.origin + point(path.bounds.size.width, path.bounds.size.height),
                bottom_right,
                "{symbol}"
            );
            assert!(!path.vertices.is_empty());
        }
    }
    for symbol in [
        "",
        "a",
        "\u{e0b0}\u{fe0f}",
        "\u{e0b6}\u{301}",
        "\u{e0b0}\u{e0b0}",
    ] {
        assert!(CellSeparator::from_symbol(symbol).is_none(), "{symbol:?}");
    }
    Ok(())
}

#[gpui::test]
fn separator_paths_match_gpui_backgrounds_at_half_device_pixels(cx: &mut gpui::TestAppContext) {
    use crate::terminal_painter::grid::grid_corners;
    use gpui::{Empty, Point, Styled, canvas, fill, rgb};
    use std::{cell::RefCell, rc::Rc};
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    let paths = Rc::new(RefCell::new(Vec::new()));
    let painted = paths.clone();
    cx.draw(Point::default(), size(px(100.), px(100.)), |_, _| {
        canvas(
            |_, _, _| (),
            move |_, _, window, _| {
                let scale = window.scale_factor();
                for offset in [0.5, -0.5, 1.5, -1.5] {
                    let (near, far) = (
                        point(px(offset / scale), px((20. + offset) / scale)),
                        point(px((20. + offset) / scale), px((60. + offset) / scale)),
                    );
                    window.paint_quad(fill(Bounds::from_corners(near, far), rgb(0x123456)));
                    let (near, far) = grid_corners(window, Point::default(), near, far);
                    let Ok(path) = CellSeparator::LeftRound.path(near, far) else {
                        panic!("simple cap path must tessellate");
                    };
                    assert_eq!(path.bounds.left(), px(offset.trunc() / scale));
                    painted.borrow_mut().push(path.bounds.scale(scale));
                }
            },
        )
        .size_full()
    });
    cx.update(|window, _| {
        let quads = window.painted_quads();
        assert_eq!(quads.len(), 4);
        for (quad, path) in quads.iter().zip(paths.borrow().iter()) {
            assert_eq!(quad.bounds, *path);
        }
    });
}
