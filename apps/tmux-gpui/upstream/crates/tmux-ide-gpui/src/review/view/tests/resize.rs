//! Resizing the review's notes panel by its edge.
use super::{changes, line, the, window};
use gpui::{Modifiers, MouseButton, MouseDownEvent, point, px};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

#[gpui::test]
fn dragging_the_notes_edge_resizes_it_and_a_double_click_resets(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(changes(), window, cx)));
    draw(cx);
    let panel = cx.debug_bounds("review-notes").unwrap();
    assert_eq!(panel.size.width, px(300.));
    let edge = cx.debug_bounds("review-notes-resize").unwrap();
    assert!(
        (edge.left() - panel.left()).abs() <= px(1.),
        "on the inner edge: {edge:?} {panel:?}"
    );

    // Dragging the edge 120px left widens the panel by as much.
    let start = edge.center();
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        point(start.x - px(40.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_move(
        point(start.x - px(120.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    draw(cx);
    let wider = cx.debug_bounds("review-notes").unwrap();
    assert!((wider.size.width - px(420.)).abs() <= px(4.), "{wider:?}");
    assert_eq!(wider.right(), panel.right(), "the far edge stays put");
    // Released, the new width is saved once and kept.
    cx.simulate_mouse_up(
        point(start.x - px(120.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    view.update(cx, |view, _| {
        assert!(view.notes_width.chosen().is_some());
        assert!(!view.notes_width.take_unsaved(), "saved on release");
    });

    // Never wider than its share of the window.
    let edge = cx.debug_bounds("review-notes-resize").unwrap();
    cx.simulate_mouse_down(edge.center(), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        point(edge.center().x - px(40.), edge.center().y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_move(
        point(px(0.), edge.center().y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_up(
        point(px(0.), edge.center().y),
        MouseButton::Left,
        Modifiers::default(),
    );
    draw(cx);
    let viewport = view.read_with(cx, |view, _| view.viewport_width);
    let widest = cx.debug_bounds("review-notes").unwrap();
    assert!(
        f32::from(widest.size.width) <= viewport * 0.6 + 1.,
        "{widest:?}"
    );

    // A double-click on the edge goes back to the default.
    let edge = cx.debug_bounds("review-notes-resize").unwrap();
    cx.simulate_event(MouseDownEvent {
        position: edge.center(),
        button: MouseButton::Left,
        modifiers: Modifiers::default(),
        click_count: 2,
        first_mouse: false,
    });
    draw(cx);
    assert_eq!(
        cx.debug_bounds("review-notes").unwrap().size.width,
        px(300.)
    );
    view.read_with(cx, |view, _| assert_eq!(view.notes_width.chosen(), None));
}

#[gpui::test]
fn a_narrow_review_hides_its_panels_until_asked(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.simulate_resize(gpui::size(px(900.), px(700.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(changes(), window, cx);
        })
    });
    // The first frame measures the review; the next one follows it.
    draw(cx);
    draw(cx);
    assert!(cx.debug_bounds("review-files").is_none());
    assert!(cx.debug_bounds("review-notes").is_none());

    // The header's icons bring each back, kept to its share of the review.
    for toggle in ["review-toggle-files", "review-toggle-notes"] {
        let icon = cx.debug_bounds(toggle).unwrap();
        cx.simulate_click(icon.center(), Modifiers::default());
        draw(cx);
    }
    let files = cx.debug_bounds("review-files").unwrap();
    let notes = cx.debug_bounds("review-notes").unwrap();
    let review = notes.right() - files.left();
    assert!(
        files.size.width <= review * 0.3 + px(1.),
        "{files:?} of {review:?}"
    );
    assert!(
        notes.size.width <= review * 0.3 + px(1.),
        "{notes:?} of {review:?}"
    );
    assert!(notes.left() - files.right() >= review * 0.4 - px(1.));

    // Hidden again, the notes come back for a note being written.
    let icon = cx.debug_bounds("review-toggle-notes").unwrap();
    cx.simulate_click(icon.center(), Modifiers::default());
    draw(cx);
    assert!(cx.debug_bounds("review-notes").is_none());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.begin_review_note(the(view), line(3), window, cx)
        })
    });
    draw(cx);
    assert!(
        cx.debug_bounds("review-notes").is_some(),
        "the composer shows"
    );
}

#[gpui::test]
fn a_wide_review_shows_its_panels_unless_hidden(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.simulate_resize(gpui::size(px(1600.), px(900.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(changes(), window, cx);
        })
    });
    draw(cx);
    draw(cx);
    assert!(cx.debug_bounds("review-files").is_some());
    assert!(cx.debug_bounds("review-notes").is_some());
    let icon = cx.debug_bounds("review-toggle-files").unwrap();
    cx.simulate_click(icon.center(), Modifiers::default());
    draw(cx);
    assert!(
        cx.debug_bounds("review-files").is_none(),
        "the choice holds"
    );
    // Queued notes are counted on the notes icon.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let id = the(view);
            view.begin_review_note(id, line(3), window, cx);
            let input = view.reviews[&id].input.clone();
            input.update(cx, |input, cx| input.set_text_selected("Fix", cx));
            view.add_review_note(id, window, cx);
        })
    });
    draw(cx);
    let icon = cx.debug_bounds("review-toggle-notes").unwrap();
    assert!(icon.size.width > px(30.), "it carries a count: {icon:?}");
}
