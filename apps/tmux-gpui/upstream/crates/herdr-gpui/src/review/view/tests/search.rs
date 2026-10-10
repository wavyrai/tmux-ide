//! Finding text in the diff.
use super::{line, the, window};
use crate::review::{
    diff::Diff,
    view::{Loaded, search::holds},
};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

#[test]
fn lower_case_queries_ignore_ascii_case() {
    assert!(holds("Hello World", "world", true));
    assert!(!holds("Hello world", "World", false));
    assert!(holds("anything", "", true));
}

#[gpui::test]
fn matches_are_found_stepped_through_and_opened(cx: &mut gpui::TestAppContext) {
    let mut diff = Diff::parse(
        "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,1 +1,1 @@\n-let needle = 1;\n+let needle = 2;\n",
    );
    diff.add_untracked("b.rs", "nothing\nNeedle here\n");
    let mut loaded = Loaded::of(diff);
    loaded.diff.files[1].folded = true;
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(loaded, window, cx);
            view.open_review_search(the(view), window, cx);
            let input = view.reviews.values().next().unwrap().search.input.clone();
            input.update(cx, |input, cx| input.set_text_selected("needle", cx));
        })
    });
    cx.run_until_parked();
    draw(cx);
    assert!(cx.debug_bounds("review-search").is_some());
    let state = |cx: &mut gpui::VisualTestContext| {
        view.read_with(cx, |view, _| {
            let search = &view.reviews.values().next().unwrap().search;
            (
                search.found(line(1)),
                search.found(line(2)),
                search.found(crate::review::diff::RowId::Line { file: 1, line: 2 }),
            )
        })
    };
    // Three matches, ignoring case; the first is shown.
    assert_eq!(state(cx), (Some(true), Some(false), Some(false)));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.step_review_search(the(view), true, cx);
        })
    });
    // Back from the first is the last, in a folded file it opens.
    assert_eq!(state(cx), (Some(false), Some(false), Some(true)));
    view.read_with(cx, |view, _| {
        let review = view.reviews.values().next().unwrap();
        assert!(!review.loaded().unwrap().diff.files[1].folded);
    });
}
