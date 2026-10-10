//! Colours are worked out for the lines drawn, after they are drawn.
use super::{changes, window};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

#[gpui::test]
fn drawn_lines_are_coloured_and_their_changed_words_marked(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(changes(), window, cx)));
    let coloured = |cx: &mut gpui::VisualTestContext, line: usize| {
        view.read_with(cx, |view, _| {
            let review = view.reviews.values().next().unwrap();
            review
                .colours
                .line(0, 1, line)
                .map(|(spans, words)| (spans.len(), words.len()))
        })
    };
    assert_eq!(coloured(cx, 3), None, "nothing before it is drawn");
    draw(cx);
    cx.run_until_parked();
    let (spans, words) = coloured(cx, 3).unwrap();
    assert!(spans > 0, "the added line has syntax colours");
    assert_eq!(words, 1, "and the words it changed: `todo!() `");
    let (_, removed_words) = coloured(cx, 2).unwrap();
    assert_eq!(removed_words, 0, "nothing was taken out of `fn b() {{}}`");
}

#[gpui::test]
fn both_sides_of_a_long_replacement_are_coloured(cx: &mut gpui::TestAppContext) {
    use crate::review::{
        diff::Diff,
        view::{Layout, Loaded},
    };
    // 500 lines replaced: each pair joins a removed line from one stretch
    // with an added line from another.
    let removed: String = (0..500)
        .map(|line| format!("-let old_{line} = {line};\n"))
        .collect();
    let added: String = (0..500)
        .map(|line| format!("+let new_{line} = {line};\n"))
        .collect();
    let diff = Diff::parse(&format!(
        "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,500 +1,500 @@\n{removed}{added}"
    ));
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let id = view.seed_review(Loaded::of(diff), window, cx);
            view.set_review_layout(id, Layout::Split, cx);
        })
    });
    draw(cx);
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        let colours = &view.reviews.values().next().unwrap().colours;
        // The first pair: removed line 1, added line 501.
        let left = colours.line(0, 1, 1).unwrap();
        let right = colours.line(0, 401, 501).unwrap();
        assert!(!left.0.is_empty() && !right.0.is_empty());
    });
}
