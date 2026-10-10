//! The list of changed files beside the diff.
use super::the;
use super::window;
use crate::review::{
    diff::{Diff, RowId},
    view::{Layout, Loaded},
};
use gpui::{Modifiers, MouseButton, point, px};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

/// Files in Git's sorted order, each long enough to scroll past.
pub(super) fn many_files() -> Loaded {
    let mut diff = Diff::parse(
        "diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
 # demo
-old
+new
",
    );
    let long: String = (0..80).map(|line| format!("line {line}\n")).collect();
    for name in ["src/a.rs", "src/b.rs", "tests/c.rs", "z.txt"] {
        diff.add_untracked(name, &long);
    }
    Loaded::of(diff)
}

#[gpui::test]
fn clicking_a_file_brings_it_to_the_top_in_either_layout(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.simulate_resize(gpui::size(px(1600.), px(900.)));
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(many_files(), window, cx)));
    draw(cx);
    draw(cx);
    let top = |cx: &mut gpui::VisualTestContext| {
        view.read_with(cx, |view, _| {
            view.reviews.values().next().unwrap().top_file()
        })
    };
    assert_eq!(top(cx), Some(0));
    // A file whose header already shows still moves to the top.
    assert!(
        cx.debug_bounds("review-header-1").is_some(),
        "src/a.rs shows"
    );
    let shown = cx.debug_bounds("review-file-1").unwrap();
    cx.simulate_click(shown.center(), Modifiers::default());
    draw(cx);
    draw(cx);
    assert_eq!(top(cx), Some(1));
    for layout in [Layout::Unified, Layout::Split] {
        cx.update(|_, cx| {
            view.update(cx, |view, cx| view.set_review_layout(the(view), layout, cx))
        });
        draw(cx);
        let file = cx.debug_bounds("review-file-3").unwrap();
        cx.simulate_click(file.center(), Modifiers::default());
        draw(cx);
        draw(cx);
        assert_eq!(top(cx), Some(3), "{layout:?}");
        assert!(cx.debug_bounds("review-header-0").is_none(), "{layout:?}");
        let back = cx.debug_bounds("review-file-0").unwrap();
        cx.simulate_click(back.center(), Modifiers::default());
        draw(cx);
        draw(cx);
        assert_eq!(top(cx), Some(0), "{layout:?}");
    }
}

#[gpui::test]
fn folders_close_filters_narrow_and_viewed_files_fold(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.simulate_resize(gpui::size(px(1600.), px(900.)));
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(many_files(), window, cx)));
    draw(cx);
    // `src/` holds two files; closed, they leave the list.
    assert!(cx.debug_bounds("review-file-1").is_some());
    let folder = cx.debug_bounds("review-folder-1").unwrap();
    cx.simulate_click(folder.center(), Modifiers::default());
    draw(cx);
    assert!(cx.debug_bounds("review-file-1").is_none());
    assert!(cx.debug_bounds("review-file-2").is_none());
    assert!(cx.debug_bounds("review-file-3").is_some());
    cx.simulate_click(folder.center(), Modifiers::default());
    draw(cx);
    assert!(cx.debug_bounds("review-file-1").is_some());

    // The filter keeps paths holding its text, in any case.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let filter = view.reviews.values().next().unwrap().filter.clone();
            filter.update(cx, |input, cx| input.set_text_selected("B.RS", cx));
        })
    });
    draw(cx);
    assert!(cx.debug_bounds("review-file-2").is_some());
    assert!(cx.debug_bounds("review-file-1").is_none());
    assert!(cx.debug_bounds("review-file-0").is_none());
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let filter = view.reviews.values().next().unwrap().filter.clone();
            filter.update(cx, |input, cx| input.clear(cx));
        })
    });
    draw(cx);

    // Marked viewed in the diff, a file folds; hidden, it leaves the list.
    let viewed = cx.debug_bounds("review-viewed-0").unwrap();
    cx.simulate_click(viewed.center(), Modifiers::default());
    draw(cx);
    view.read_with(cx, |view, _| {
        let review = view.reviews.values().next().unwrap();
        assert!(review.is_viewed(0));
        assert!(review.loaded().unwrap().diff.files[0].folded);
        // Folded, the file is its header alone: the next file follows it.
        assert_eq!(review.position_of(RowId::Header(1)), Some(1));
    });
    let hide = cx.debug_bounds("review-hide-viewed").unwrap();
    cx.simulate_click(hide.center(), Modifiers::default());
    draw(cx);
    assert!(cx.debug_bounds("review-file-0").is_none());
    assert!(cx.debug_bounds("review-file-1").is_some());
}

#[gpui::test]
fn the_arrows_pick_a_file_and_enter_shows_it(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.simulate_resize(gpui::size(px(1600.), px(900.)));
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(many_files(), window, cx)));
    draw(cx);
    let first = cx.debug_bounds("review-file-0").unwrap();
    cx.simulate_click(first.center(), Modifiers::default());
    draw(cx);
    // README, `src/`, then src/a.rs and src/b.rs.
    cx.simulate_keystrokes("down down down enter");
    draw(cx);
    draw(cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.reviews.values().next().unwrap().top_file(), Some(2));
    });
}

#[gpui::test]
fn the_file_list_resizes_by_its_right_edge(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(many_files(), window, cx)));
    draw(cx);
    let list = cx.debug_bounds("review-files").unwrap();
    assert_eq!(list.size.width, px(240.));
    // A file's line, and so the current file's band, spans the list.
    let line = cx.debug_bounds("review-file-0").unwrap();
    assert!(line.size.width > px(200.), "{line:?}");
    let edge = cx.debug_bounds("review-files-resize").unwrap();
    assert!(
        (edge.right() - list.right()).abs() <= px(1.),
        "{edge:?} {list:?}"
    );
    let start = edge.center();
    let to = point(start.x + px(100.), start.y);
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(
        point(start.x + px(40.), start.y),
        MouseButton::Left,
        Modifiers::default(),
    );
    cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    draw(cx);
    let wider = cx.debug_bounds("review-files").unwrap();
    assert!((wider.size.width - px(340.)).abs() <= px(4.), "{wider:?}");
    view.update(cx, |view, _| {
        assert!(view.review_files_width.chosen().is_some());
        assert!(!view.review_files_width.take_unsaved(), "saved on release");
    });
}
