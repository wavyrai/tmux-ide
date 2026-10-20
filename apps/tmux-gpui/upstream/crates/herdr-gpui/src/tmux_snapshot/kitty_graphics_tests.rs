use super::*;

#[test]
fn maps_a_clipped_placement_onto_its_source_rectangle() {
    let json = serde_json::json!({
        "placements": [{
            "id": "kitty:9:1:0:2:4", "kind": "kitty-image", "row": 0, "column": 3,
            "columns": 4, "rows": 1, "contentDigest": "00000000000000ff"
        }],
        "kittyImages": [{
            "digest": "00000000000000ff", "format": "rgba", "width": 2, "height": 2,
            "data": "AAAA/wAAAP8AAAD/AAAA/w=="
        }]
    });
    let graphics = graphics(&serde_json::to_vec(&json).unwrap(), "pane")
        .unwrap()
        .unwrap();
    let placement = &graphics.placements[0];
    assert_eq!(
        (placement.x, placement.y, placement.cols, placement.rows),
        (3, 0, 4, 1)
    );
    assert_eq!((placement.source_x, placement.source_y), (0, 1));
    assert_eq!((placement.source_width, placement.source_height), (2, 1));
    assert!(graphics.images.get(&placement.asset).is_some());
    assert_eq!(base64("aGk=").unwrap(), b"hi");
}

/// Replayed from a real tmux 3.7c control-mode transcript (see
/// `scripts/kitty-spike`): a cursor-anchored PNG after "A", a Unicode
/// placeholder image, and a DCS-passthrough-wrapped PNG.
const FIXTURE: &[u8] = include_bytes!("../../../../../fixtures/kitty-graphics-snapshot.json");

#[gpui::test]
fn paints_real_wire_kitty_images_at_their_cells(cx: &mut gpui::TestAppContext) {
    use crate::{
        config::Theme,
        terminal_painter::{ImageTarget, PlacedImages, TerminalPainter},
    };
    use gpui::{Bounds, Empty, Point, Styled, VisualTestContext, canvas, font, point, px, size};
    let frame = std::sync::Arc::new(super::super::decode::frame(FIXTURE).unwrap());
    let graphics = std::sync::Arc::new(graphics(FIXTURE, "pane").unwrap().unwrap());
    assert_eq!(graphics.placements.len(), 3);
    let (_, cx) = cx.add_window_view(|_, _| Empty);
    let painter = std::rc::Rc::new(std::cell::RefCell::new(TerminalPainter::default()));
    painter
        .borrow_mut()
        .set_appearance(14., 20., Theme::default());
    let draw = |cx: &mut VisualTestContext| {
        let (painter, graphics, frame) = (painter.clone(), graphics.clone(), frame.clone());
        cx.draw(Point::default(), size(px(800.), px(600.)), |_, _| {
            canvas(
                |_, _, _| (),
                move |_, _, window, cx| {
                    painter.borrow_mut().paint_frame(
                        &frame,
                        point(px(0.), px(0.)),
                        None,
                        10.,
                        &font("Menlo"),
                        &[],
                        &[],
                        None,
                        Some(PlacedImages {
                            placements: &graphics.placements,
                            images: &graphics.images,
                            target: ImageTarget::Main,
                        }),
                        window,
                        cx,
                    );
                },
            )
            .size_full()
        });
    };
    draw(cx);
    cx.run_until_parked();
    draw(cx);
    let cells = |col: f32, row: f32, cols: f32, rows: f32| {
        Bounds::new(
            point(px(col * 10.), px(row * 20.)),
            size(px(cols * 10.), px(rows * 20.)),
        )
    };
    let mut painted: Vec<_> = painter
        .borrow()
        .painted_images()
        .iter()
        .map(|(_, bounds)| *bounds)
        .collect();
    painted.sort_by(|a, b| a.origin.y.partial_cmp(&b.origin.y).unwrap());
    assert_eq!(
        painted,
        [
            cells(1., 2., 4., 2.),
            cells(0., 7., 3., 2.),
            cells(0., 13., 4., 2.)
        ]
    );
}
