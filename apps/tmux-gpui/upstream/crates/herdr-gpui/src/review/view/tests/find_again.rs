//! Cmd-G and Cmd-Shift-G in a review: Find Next and Find Previous.
use super::{line, window};
use crate::{
    controls::Command,
    review::{diff::Diff, view::Loaded},
};

#[gpui::test]
fn find_next_opens_the_search_then_steps_through_it(cx: &mut gpui::TestAppContext) {
    let diff = Diff::parse(
        "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,1 +1,1 @@\n-let needle = 1;\n+let needle = 2;\n",
    );
    let (view, cx) = window(cx, None);
    let run = |command, cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| view.update(cx, |view, cx| view.command(command, window, cx)));
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(Loaded::of(diff), window, cx);
            let focus = view.reviews.values().next().unwrap().focus.clone();
            window.focus(&focus, cx);
        })
    });
    run(Command::FindNext, cx);
    let open = view.read_with(cx, |view, _| {
        view.reviews.values().next().unwrap().search.open
    });
    assert!(open, "nothing searched yet: the field opens");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let input = view.reviews.values().next().unwrap().search.input.clone();
            input.update(cx, |input, cx| input.set_text_selected("needle", cx));
        })
    });
    cx.run_until_parked();
    let current = |cx: &mut gpui::VisualTestContext| {
        view.read_with(cx, |view, _| {
            let search = &view.reviews.values().next().unwrap().search;
            (search.found(line(1)), search.found(line(2)))
        })
    };
    assert_eq!(current(cx), (Some(true), Some(false)));
    run(Command::FindNext, cx);
    assert_eq!(current(cx), (Some(false), Some(true)));
    run(Command::FindPrevious, cx);
    assert_eq!(current(cx), (Some(true), Some(false)));
}
