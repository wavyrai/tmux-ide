//! Keys in the diff: moving between hunks and files, folding and marking.
use super::{line, the, window};
use crate::review::{
    diff::{Diff, RowId},
    view::Loaded,
};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

/// A hunk of `lines` added lines from line `at`.
fn hunk(at: usize, lines: usize) -> String {
    let added: String = (0..lines).map(|line| format!("+line {line}\n")).collect();
    format!("@@ -{at},0 +{at},{lines} @@\n{added}")
}

/// Two hunks in one file, one in the next, each taller than the view.
fn hunks() -> Loaded {
    Loaded::of(Diff::parse(&format!(
        "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n{}{}\
         diff --git a/b.rs b/b.rs\n--- a/b.rs\n+++ b/b.rs\n{}",
        hunk(1, 60),
        hunk(100, 60),
        hunk(5, 60),
    )))
}

#[gpui::test]
fn brackets_move_between_hunks_and_files_and_x_folds(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(hunks(), window, cx);
            let focus = view.reviews.values().next().unwrap().focus.clone();
            window.focus(&focus, cx);
        })
    });
    draw(cx);
    let top = |cx: &mut gpui::VisualTestContext| {
        view.read_with(cx, |view, _| {
            view.reviews.values().next().unwrap().top_row()
        })
    };
    assert_eq!(top(cx), Some(RowId::Header(0)));
    cx.simulate_keystrokes("]");
    assert_eq!(top(cx), Some(line(0)));
    cx.simulate_keystrokes("]");
    assert_eq!(top(cx), Some(line(61)));
    cx.simulate_keystrokes("]");
    assert_eq!(top(cx), Some(RowId::Line { file: 1, line: 0 }));
    cx.simulate_keystrokes("[");
    assert_eq!(top(cx), Some(RowId::Header(1)));
    cx.simulate_keystrokes(",");
    assert_eq!(top(cx), Some(RowId::Header(0)));
    cx.simulate_keystrokes(".");
    assert_eq!(top(cx), Some(RowId::Header(1)));
    // `x` folds the file at the top, `v` marks it viewed, which folds it.
    cx.simulate_keystrokes(", x");
    view.read_with(cx, |view, _| {
        let review = view.reviews.values().next().unwrap();
        assert!(review.loaded().unwrap().diff.files[0].folded);
        assert_eq!(review.position_of(RowId::Header(1)), Some(1));
    });
    cx.simulate_keystrokes("x v");
    view.read_with(cx, |view, _| {
        let review = view.reviews.values().next().unwrap();
        assert!(review.is_viewed(0));
        assert!(review.loaded().unwrap().diff.files[0].folded);
    });
    // Typing in a field never moves the diff.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_review_search(the(view), window, cx);
        })
    });
    cx.simulate_keystrokes("]");
    assert_eq!(top(cx), Some(RowId::Header(0)));
}

#[gpui::test]
fn ignoring_whitespace_reads_the_changes_again(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(hunks(), window, cx);
            let request = view.reviews[&the(view)].request;
            view.toggle_review_whitespace(the(view), cx);
            let review = &view.reviews[&the(view)];
            assert!(review.ignore_whitespace);
            assert!(review.request > request);
        })
    });
}
