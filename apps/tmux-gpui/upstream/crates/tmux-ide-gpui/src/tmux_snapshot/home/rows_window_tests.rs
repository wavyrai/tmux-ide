use super::*;
use core::prelude::v1::test;

const ROW: Pixels = px(40.);

#[test]
fn an_unmeasured_run_or_a_page_without_height_builds_every_row() {
    assert_eq!(visible(None, 100, ROW, (px(0.), px(800.)), px(0.)), 0..100);
    assert_eq!(
        visible(Some(px(200.)), 100, ROW, (px(0.), px(0.)), px(0.)),
        0..100
    );
}

#[test]
fn rows_within_a_page_above_and_below_are_built() {
    // The page shows 0..800; the run starts at 200; rows are 40 tall.
    // Built: up to a quarter page below, 800 + 200 = 1000 → (1000 - 200) / 40 = 20.
    assert_eq!(
        visible(Some(px(200.)), 100, ROW, (px(0.), px(800.)), px(0.)),
        0..20
    );
    // Scrolled down 2000: the run's first row is at -1800. Built from
    // -200: (-200 + 1800) / 40 = 40, to 1000: (1000 + 1800) / 40 = 70.
    assert_eq!(
        visible(Some(px(200.)), 100, ROW, (px(0.), px(800.)), px(-2000.)),
        40..70
    );
    // Scrolled to the end: never past the run. -200 + 3800 = 3600 / 40 = 90.
    assert_eq!(
        visible(Some(px(200.)), 100, ROW, (px(0.), px(800.)), px(-4000.)),
        90..100
    );
    // A short run, all on screen.
    assert_eq!(
        visible(Some(px(200.)), 3, ROW, (px(0.), px(800.)), px(0.)),
        0..3
    );
    // A run far below the page: nothing built.
    assert_eq!(
        visible(Some(px(5000.)), 10, ROW, (px(0.), px(800.)), px(0.)),
        0..0
    );
}

#[test]
fn the_keyboard_row_stays_built_on_its_own() {
    assert_eq!(
        plan(6, 0..2, Some(4)),
        vec![
            Span::Row(0),
            Span::Row(1),
            Span::Gap(2),
            Span::Row(4),
            Span::Gap(1)
        ]
    );
    assert_eq!(
        plan(3, 0..3, Some(1)),
        vec![Span::Row(0), Span::Row(1), Span::Row(2)]
    );
    assert_eq!(
        plan(5, 2..3, None),
        vec![Span::Gap(2), Span::Row(2), Span::Gap(2)]
    );
    assert_eq!(plan(4, 0..0, None), vec![Span::Gap(4)]);
    // An unmeasured page builds everything.
    let window = RowWindow::default();
    let page = ScrollHandle::new();
    assert_eq!(
        window.plan((0, 0), 3, ROW, &page, None),
        vec![Span::Row(0), Span::Row(1), Span::Row(2)]
    );
}
