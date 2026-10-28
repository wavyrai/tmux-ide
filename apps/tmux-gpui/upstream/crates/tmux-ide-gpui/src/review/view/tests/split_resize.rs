//! Moving the line between a side-by-side diff's halves.
use super::{changes, the, window};
use crate::review::view::Layout;
use gpui::{Modifiers, MouseButton, MouseDownEvent, point, px};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

#[gpui::test]
fn the_line_between_the_sides_drags_and_resets(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(changes(), window, cx);
            view.set_review_layout(the(view), Layout::Split, cx);
        })
    });
    // The list lays out once before the line knows where to sit.
    draw(cx);
    draw(cx);
    let left = cx.debug_bounds("review-left-0-2").unwrap();
    let line = cx.debug_bounds("review-split-divider").unwrap();
    assert!(
        (line.center().x - left.right()).abs() <= px(4.),
        "{line:?} {left:?}"
    );

    // Dragged 120px right, the old side grows by as much.
    let start = line.center();
    let to = point(start.x + px(120.), start.y);
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        point(start.x + px(40.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    draw(cx);
    let wider = cx.debug_bounds("review-left-0-2").unwrap();
    assert!(
        (wider.size.width - left.size.width - px(120.)).abs() <= px(4.),
        "{wider:?}"
    );
    assert!(cx.debug_bounds("review-right-0-3").unwrap().left() >= wider.right());

    // Either side keeps a fifth of the row.
    let line = cx.debug_bounds("review-split-divider").unwrap();
    cx.simulate_mouse_down(line.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        point(line.center().x - px(40.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_move(
        point(px(0.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_up(
        point(px(0.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    view.read_with(cx, |view, _| {
        let ratio = view.reviews.values().next().unwrap().split_ratio;
        assert!((ratio - 0.2).abs() < 0.001, "{ratio}");
    });

    // A double-click on the line evens the sides again.
    draw(cx);
    let line = cx.debug_bounds("review-split-divider").unwrap();
    cx.simulate_event(MouseDownEvent {
        position: line.center(),
        button: MouseButton::Left,
        modifiers: Modifiers::default(),
        click_count: 2,
        first_mouse: false,
    });
    draw(cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.reviews.values().next().unwrap().split_ratio, 0.5);
    });
    assert!(
        (cx.debug_bounds("review-left-0-2").unwrap().size.width - left.size.width).abs() <= px(1.)
    );

    // Unified, there is no line to drag.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.set_review_layout(the(view), Layout::Unified, cx)
        })
    });
    draw(cx);
    assert!(cx.debug_bounds("review-split-divider").is_none());
}
