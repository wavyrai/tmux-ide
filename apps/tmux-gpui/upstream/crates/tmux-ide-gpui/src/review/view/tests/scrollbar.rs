//! The diff's scrollbar.
use super::{changes, the, window};
use crate::review::diff::Diff;
use crate::review::view::Loaded;

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

fn long() -> Loaded {
    let mut diff = Diff::default();
    let text: String = (0..400).map(|line| format!("line {line}\n")).collect();
    diff.add_untracked("long.rs", &text);
    Loaded::of(diff)
}

#[gpui::test]
fn a_long_diff_has_a_thumb_that_drags_it(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(long(), window, cx)));
    // The list lays out once before its handle knows how far it scrolls.
    draw(cx);
    draw(cx);
    let area = cx.debug_bounds("review-header-0").unwrap();
    let thumb = cx.debug_bounds("review-scroll-thumb").unwrap();
    assert!(
        (thumb.top() - area.top()).abs() < gpui::px(1.),
        "starts at the top"
    );
    assert!(thumb.size.height < gpui::px(200.), "a share of the list");
    assert!(thumb.right() <= area.right());

    // Dragging the thumb to the bottom scrolls to the end of the diff.
    let scrolled = cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.grab_review_thumb(the(view), thumb.top() + gpui::px(1.));
            view.drag_review_thumb(the(view), thumb.top() + gpui::px(5000.))
        })
    });
    assert!(scrolled);
    draw(cx);
    let moved = cx.debug_bounds("review-scroll-thumb").unwrap();
    assert!(moved.top() > thumb.top() + gpui::px(100.), "{moved:?}");
    assert!(
        cx.debug_bounds("review-header-0").is_none(),
        "scrolled past the top"
    );
    assert!(
        cx.debug_bounds("review-line-0-400").is_some(),
        "the last line shows"
    );
}

#[gpui::test]
fn a_diff_that_fits_has_no_thumb(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(changes(), window, cx)));
    draw(cx);
    draw(cx);
    assert!(cx.debug_bounds("review-header-0").is_some());
    assert!(cx.debug_bounds("review-scroll-thumb").is_none());
}
