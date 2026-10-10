//! Selecting and copying the diff's code with the pointer and keys, and
//! noting a line from its gutter.
use super::{changes, files::many_files, line, the, window};
use crate::review::{diff::RowId, view::Layout};
use gpui::{Modifiers, MouseButton, point, px};

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

fn clipboard(cx: &mut gpui::VisualTestContext) -> Option<String> {
    cx.update(|_, cx| cx.read_from_clipboard())
        .and_then(|item| item.text())
}

#[gpui::test]
fn dragging_over_code_copies_only_code(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(changes(), window, cx)));
    draw(cx);
    draw(cx);
    // From the unchanged line's code to past the end of the added line's.
    let gutter = cx.debug_bounds("review-gutter-line-0-1").unwrap();
    let from = point(gutter.right() + px(1.), gutter.center().y);
    let added = cx.debug_bounds("review-line-0-3").unwrap();
    let to = point(added.right() - px(2.), added.center().y);
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    draw(cx);
    cx.simulate_keystrokes("cmd-c");
    assert_eq!(
        clipboard(cx).as_deref(),
        Some("fn a() {}\nfn b() {}\nfn b() { todo!() }")
    );
    // No note was started by selecting.
    view.read_with(cx, |view, _| {
        assert!(view.reviews.values().next().unwrap().draft.is_none());
    });

    // Escape clears it; Cmd-C then copies nothing new.
    cx.write_to_clipboard(gpui::ClipboardItem::new_string("kept".into()));
    cx.simulate_keystrokes("escape cmd-c");
    assert_eq!(clipboard(cx).as_deref(), Some("kept"));
}

#[gpui::test]
fn the_gutter_notes_the_line_and_clicks_select_words_and_lines(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(changes(), window, cx)));
    draw(cx);
    draw(cx);
    let gutter = cx.debug_bounds("review-gutter-line-0-3").unwrap();
    cx.simulate_click(gutter.center(), Modifiers::default());
    view.read_with(cx, |view, _| {
        assert_eq!(view.reviews.values().next().unwrap().draft, Some(line(3)));
    });

    // A double-click on the code selects the word under it, a triple-click
    // the line.
    draw(cx);
    let start = point(gutter.right() + px(2.), gutter.center().y);
    let click = |count: usize, cx: &mut gpui::VisualTestContext| {
        cx.simulate_event(gpui::MouseDownEvent {
            position: start,
            button: MouseButton::Left,
            modifiers: Modifiers::default(),
            click_count: count,
            first_mouse: false,
        });
        cx.simulate_event(gpui::MouseUpEvent {
            position: start,
            button: MouseButton::Left,
            modifiers: Modifiers::default(),
            click_count: count,
        });
    };
    click(2, cx);
    cx.simulate_keystrokes("cmd-c");
    assert_eq!(clipboard(cx).as_deref(), Some("fn"));
    click(3, cx);
    cx.simulate_keystrokes("cmd-c");
    assert_eq!(clipboard(cx).as_deref(), Some("fn b() { todo!() }"));
}

#[gpui::test]
fn select_all_takes_the_file_s_new_side_side_by_side(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(changes(), window, cx);
            view.set_review_layout(the(view), Layout::Split, cx);
            let focus = view.reviews.values().next().unwrap().focus.clone();
            window.focus(&focus, cx);
        })
    });
    draw(cx);
    cx.simulate_keystrokes("cmd-a cmd-c");
    assert_eq!(
        clipboard(cx).as_deref(),
        Some("fn a() {}\nfn b() { todo!() }")
    );
}

#[gpui::test]
fn select_all_keeps_to_the_column_last_clicked(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(changes(), window, cx);
            view.set_review_layout(the(view), Layout::Split, cx);
        })
    });
    draw(cx);
    draw(cx);
    // A click on the old column's code, then Select All.
    let old = cx.debug_bounds("review-gutter-left-0-2").unwrap();
    let code = point(old.right() + px(2.), old.center().y);
    cx.simulate_click(code, Modifiers::default());
    draw(cx);
    cx.simulate_keystrokes("cmd-a cmd-c");
    assert_eq!(clipboard(cx).as_deref(), Some("fn a() {}\nfn b() {}"));
}

#[gpui::test]
fn select_all_takes_the_file_at_the_top_not_one_scrolled_away(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(many_files(), window, cx)));
    draw(cx);
    draw(cx);
    // A word selected in README, then src/a.rs brought to the top.
    let readme = cx.debug_bounds("review-gutter-line-0-1").unwrap();
    let code = point(readme.right() + px(2.), readme.center().y);
    cx.simulate_click(code, Modifiers::default());
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let review = view.reviews.values_mut().next().unwrap();
            assert!(review.selection.is_some());
            review.scroll_to_row(RowId::Header(1));
        })
    });
    draw(cx);
    draw(cx);
    cx.simulate_keystrokes("cmd-a cmd-c");
    let copied = clipboard(cx).unwrap();
    assert!(copied.starts_with("line 0\nline 1\n"), "{copied:?}");
}

#[gpui::test]
fn headers_copy_the_path_and_the_hunk(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(changes(), window, cx)));
    draw(cx);
    draw(cx);
    let path = cx.debug_bounds("review-copy-path-0").unwrap();
    cx.simulate_click(path.center(), Modifiers::default());
    assert_eq!(clipboard(cx).as_deref(), Some("src/lib.rs"));
    let hunk = cx.debug_bounds("review-copy-hunk-0-0").unwrap();
    cx.simulate_click(hunk.center(), Modifiers::default());
    assert_eq!(
        clipboard(cx).as_deref(),
        Some("@@ -1,2 +1,2 @@\n fn a() {}\n-fn b() {}\n+fn b() { todo!() }")
    );
    // Neither started a note.
    view.read_with(cx, |view, _| {
        assert!(view.reviews.values().next().unwrap().draft.is_none());
    });
}

#[gpui::test]
fn a_line_without_code_copies_nothing(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    let marker = crate::review::view::Loaded::of(crate::review::diff::Diff::parse(
        "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n",
    ));
    cx.update(|window, cx| view.update(cx, |view, cx| view.seed_review(marker, window, cx)));
    draw(cx);
    draw(cx);
    // Triple-click the marker, then Cmd-C: the clipboard keeps what it had.
    let gutter = cx.debug_bounds("review-gutter-line-0-3").unwrap();
    let at = point(gutter.right() + px(2.), gutter.center().y);
    cx.write_to_clipboard(gpui::ClipboardItem::new_string("kept".into()));
    for count in 1..=3 {
        cx.simulate_event(gpui::MouseDownEvent {
            position: at,
            button: MouseButton::Left,
            modifiers: Modifiers::default(),
            click_count: count,
            first_mouse: false,
        });
        cx.simulate_event(gpui::MouseUpEvent {
            position: at,
            button: MouseButton::Left,
            modifiers: Modifiers::default(),
            click_count: count,
        });
    }
    view.read_with(cx, |view, _| {
        let review = view.reviews.values().next().unwrap();
        assert!(
            review
                .selection
                .is_some_and(|selection| !selection.is_empty())
        );
    });
    cx.simulate_keystrokes("cmd-c");
    assert_eq!(clipboard(cx).as_deref(), Some("kept"));
}

/// Seeds a split review of `diff` with its keys on the review, so Cmd-A and
/// Cmd-C reach it without a click.
fn split_review<'a>(
    diff: &str,
    cx: &'a mut gpui::TestAppContext,
) -> &'a mut gpui::VisualTestContext {
    let (view, cx) = window(cx, None);
    let loaded = crate::review::view::Loaded::of(crate::review::diff::Diff::parse(diff));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(loaded, window, cx);
            view.set_review_layout(the(view), Layout::Split, cx);
            let focus = view.reviews.values().next().unwrap().focus.clone();
            window.focus(&focus, cx);
        })
    });
    draw(cx);
    cx
}

#[gpui::test]
fn select_all_of_a_deleted_file_side_by_side_takes_the_old_side(cx: &mut gpui::TestAppContext) {
    let cx = split_review(
        "diff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-fn a() {}\n-fn b() {}\n",
        cx,
    );
    cx.simulate_keystrokes("cmd-a cmd-c");
    assert_eq!(clipboard(cx).as_deref(), Some("fn a() {}\nfn b() {}"));
}

#[gpui::test]
fn select_all_leaves_a_folded_file_s_hidden_code_alone(cx: &mut gpui::TestAppContext) {
    let (view, cx) = window(cx, None);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(changes(), window, cx);
            let review = view.reviews.values_mut().next().unwrap();
            review.set_folded(0, true);
            let focus = review.focus.clone();
            window.focus(&focus, cx);
        })
    });
    draw(cx);
    cx.write_to_clipboard(gpui::ClipboardItem::new_string("kept".into()));
    cx.simulate_keystrokes("cmd-a cmd-c");
    assert_eq!(clipboard(cx).as_deref(), Some("kept"));
    view.read_with(cx, |view, _| {
        assert!(view.reviews.values().next().unwrap().selection.is_none());
    });
}
