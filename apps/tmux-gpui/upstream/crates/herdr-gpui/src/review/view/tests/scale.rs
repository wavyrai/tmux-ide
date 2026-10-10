//! A review of hundreds of thousands of lines lays out only what shows.
use super::window;
use crate::review::{
    diff::{Diff, RowId},
    view::Loaded,
};
use gpui::{ListOffset, px};
use std::time::Instant;

fn draw(cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

#[gpui::test]
fn three_hundred_thousand_lines_draw_and_scroll(cx: &mut gpui::TestAppContext) {
    let built = Instant::now();
    let mut diff = Diff::default();
    let text: String = (0..10_000)
        .map(|line| format!("let value_{line} = compute({line}, \"some text\");\n"))
        .collect();
    for file in 0..30 {
        diff.add_untracked(&format!("src/file_{file:02}.rs"), &text);
    }
    let lines: usize = diff
        .files
        .iter()
        .map(|file| file.lines().unwrap().len())
        .sum();
    assert_eq!(lines, 300_030);
    let built = built.elapsed();
    let (view, cx) = window(cx, None);
    let seeded = Instant::now();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.seed_review(Loaded::of(diff), window, cx)
        })
    });
    let seeded = seeded.elapsed();
    let started = Instant::now();
    draw(cx);
    draw(cx);
    let first = started.elapsed();
    assert!(cx.debug_bounds("review-header-0").is_some());

    // Into the middle of the change, and to its last line.
    let started = Instant::now();
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let review = view.reviews.values_mut().next().unwrap();
            review.scroll.scroll_to(ListOffset {
                item_ix: 150_000,
                offset_in_item: px(0.),
            });
        })
    });
    draw(cx);
    let top = view.read_with(cx, |view, _| {
        view.reviews.values().next().unwrap().top_row()
    });
    assert!(matches!(top, Some(RowId::Line { file: 14, .. })), "{top:?}");
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.reviews
                .values_mut()
                .next()
                .unwrap()
                .scroll
                .scroll_to_end();
        })
    });
    draw(cx);
    draw(cx);
    assert!(
        cx.debug_bounds("review-line-29-10000").is_some(),
        "the last line shows"
    );
    eprintln!(
        "300k lines: built {built:?}, seeded {seeded:?}, first draw {first:?}, middle and end {:?}",
        started.elapsed()
    );
}
