//! Long lines wrap inside the diff instead of running past its edge.
use super::{line, the, window};
use crate::review::{
    diff::Diff,
    view::{Layout, Loaded},
};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

/// A short line changed into one far wider than any window, then a
/// short line after it.
fn long_line() -> Loaded {
    let long = "word ".repeat(400);
    Loaded::of(Diff::parse(&format!(
        "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,2 @@\n-fn b() {{}}\n+{long}\n fn c() {{}}\n"
    )))
}

#[gpui::test]
fn a_long_line_wraps_within_the_diff(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(long_line(), window, cx)));
    draw(cx);
    draw(cx);
    let short = cx.debug_bounds("review-line-0-1").unwrap();
    let long = cx.debug_bounds("review-line-0-2").unwrap();
    let after = cx.debug_bounds("review-line-0-3").unwrap();
    assert!(long.size.height > short.size.height * 3., "{long:?}");
    assert_eq!(
        short.size.height, after.size.height,
        "short lines stay one line"
    );
    assert!(
        long.right() <= short.right() + gpui::px(1.),
        "{long:?} {short:?}"
    );
    assert!(
        after.top() >= long.bottom() - gpui::px(1.),
        "the next row follows"
    );

    // Side by side, the pair is as tall as its longer side.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.set_review_layout(the(view), Layout::Split, cx)
        })
    });
    draw(cx);
    draw(cx);
    let left = cx.debug_bounds("review-left-0-1").unwrap();
    let right = cx.debug_bounds("review-right-0-2").unwrap();
    assert!(right.size.height > short.size.height * 3., "{right:?}");
    assert_eq!(left.size.height, right.size.height);
    assert_eq!(left.top(), right.top());
}

/// A new file long enough to scroll.
fn many() -> Loaded {
    let mut diff = Diff::default();
    let text: String = (0..400).map(|line| format!("line {line}\n")).collect();
    diff.add_untracked("long.rs", &text);
    Loaded::of(diff)
}

#[gpui::test]
fn switching_layout_keeps_the_top_row(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(many(), window, cx)));
    draw(cx);
    let top = |cx: &mut gpui::VisualTestContext| {
        view.read_with(cx, |view, _| {
            view.reviews.values().next().unwrap().top_row()
        })
    };
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let review = view.reviews.values().next().unwrap();
            review.scroll.scroll_to(gpui::ListOffset {
                item_ix: 200,
                offset_in_item: gpui::px(0.),
            });
        })
    });
    draw(cx);
    assert_eq!(top(cx), Some(line(199)));
    for layout in [Layout::Split, Layout::Unified] {
        cx.update(|_, cx| {
            view.update(cx, |view, cx| view.set_review_layout(the(view), layout, cx))
        });
        draw(cx);
        assert_eq!(top(cx), Some(line(199)), "{layout:?}");
    }
}
