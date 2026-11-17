use super::*;
use crate::tmux_snapshot::browser_ui::{sidebar, sidebar_view::row_shape};
use core::prelude::v1::test;

fn row(lead: f32, height: f32) -> Option<Space> {
    Some(Space {
        lead: px(lead),
        height: px(height),
    })
}

/// Indices of the rows the plan builds.
fn built(plan: &[Option<Space>]) -> Vec<usize> {
    (0..plan.len())
        .filter(|index| plan[*index].is_none())
        .collect()
}

#[test]
fn a_list_not_laid_out_yet_builds_every_row() {
    let spaces = vec![row(2., 30.); 10];
    assert_eq!(
        built(&plan(&spaces, None, px(300.), px(0.), |_| false)).len(),
        10
    );
    let flat = plan(&spaces, Some(px(0.)), px(0.), px(0.), |_| false);
    assert_eq!(built(&flat).len(), 10);
}

/// Rows of 32 pt in a 320 pt list: rows 0..=12 reach a quarter of the list
/// (80 pt) past its bottom edge; the rest are placeholders of their size.
#[test]
fn rows_within_a_quarter_of_the_list_are_built() {
    let spaces = vec![row(2., 30.); 40];
    let at_top = plan(&spaces, Some(px(0.)), px(320.), px(0.), |_| false);
    assert_eq!(built(&at_top), (0..=12).collect::<Vec<_>>());
    assert_eq!(at_top[20], spaces[20], "a placeholder is its row's size");
    // Scrolled by 640 pt: rows 20..=29 show, 17..=32 reach within the margin.
    let scrolled = plan(&spaces, Some(px(0.)), px(320.), px(-640.), |_| false);
    assert_eq!(built(&scrolled), (17..=32).collect::<Vec<_>>());
}

#[test]
fn a_row_never_measured_is_built_and_so_is_every_row_after_it() {
    let mut spaces = vec![row(2., 30.); 40];
    spaces[30] = None;
    let at_top = plan(&spaces, Some(px(0.)), px(320.), px(0.), |_| false);
    let mut expected: Vec<usize> = (0..=12).collect();
    expected.extend(30..40);
    assert_eq!(built(&at_top), expected);
}

#[test]
fn kept_rows_stay_built_wherever_they_are() {
    let spaces = vec![row(2., 30.); 40];
    let at_top = plan(&spaces, Some(px(0.)), px(320.), px(0.), |index| index == 35);
    assert!(at_top[35].is_none());
    assert!(at_top[34].is_some());
}

/// The lead is what lies between a row and the one above: the list's gap
/// and the row's own margin, as a heading's 10 pt.
#[test]
fn sizes_are_learned_from_the_layout_and_only_for_rows_shown() {
    let bounds = [
        Bounds::new(point(px(0.), px(8.)), size(px(200.), px(28.))),
        Bounds::new(point(px(0.), px(48.)), size(px(200.), px(26.))),
        Bounds::new(point(px(0.), px(76.)), size(px(200.), px(30.))),
    ];
    let mut sizes = HashMap::from([(
        99,
        Space {
            lead: px(1.),
            height: px(1.),
        },
    )]);
    learn(&mut sizes, &[7, 8], &bounds);
    assert_eq!(sizes.get(&7), row(12., 26.).as_ref());
    assert_eq!(sizes.get(&8), row(2., 30.).as_ref());
    assert!(
        !sizes.contains_key(&99),
        "a row no longer shown is forgotten"
    );
    // A layout of another list (a stale frame) teaches nothing.
    learn(&mut sizes, &[7], &bounds);
    assert_eq!(sizes.len(), 2);
}

/// A row's remembered size belongs to its shape: content that can change
/// its height (a summary added or removed, a new kind, its agent appearing)
/// gives it a new shape, so it is built and measured again.
#[test]
fn a_row_changed_in_any_way_has_a_new_shape() {
    let base = || sidebar::Row {
        label: "project".into(),
        target: Some(sidebar::Target::Session("s1".into())),
        ..Default::default()
    };
    let shape = row_shape(&base(), false, false);
    assert_eq!(row_shape(&base(), false, false), shape);
    let summary = sidebar::Row {
        summary: Some("two lines of summary".into()),
        ..base()
    };
    assert_ne!(row_shape(&summary, false, false), shape);
    let heading = sidebar::Row {
        kind: sidebar::Kind::Heading,
        ..base()
    };
    assert_ne!(row_shape(&heading, false, false), shape);
    assert_ne!(row_shape(&base(), true, false), shape);
    assert_ne!(row_shape(&base(), false, true), shape);
}

fn frame(rem: f32) -> Frame {
    Frame {
        rem: px(rem),
        viewport: px(700.),
        every: false,
        reveal: None,
    }
}

const AT_TOP: View = View {
    start: Some(px(0.)),
    height: px(320.),
    offset: px(0.),
};

/// The Home row ending at 0, then `count` rows of 30 pt, 2 pt apart.
fn laid_out(count: usize) -> Vec<Bounds<Pixels>> {
    (0..=count)
        .map(|index| {
            let top = px(32. * index as f32 - 30.);
            Bounds::new(point(px(0.), top), size(px(200.), px(30.)))
        })
        .collect()
}

fn remembering(window: &RowWindow, shapes: &[u64], rem: f32) {
    window.plan_at(shapes, frame(rem), AT_TOP, |_| false);
    learn(
        &mut window.0.borrow_mut().sizes,
        shapes,
        &laid_out(shapes.len()),
    );
}

/// The sizes were measured at one rem size; at another an activity summary
/// may wrap differently, so every row is built and measured again.
#[test]
fn a_new_rem_size_forgets_every_size() {
    let shapes: Vec<u64> = (0..40).collect();
    let window = RowWindow::default();
    remembering(&window, &shapes, 16.);
    let same = window.plan_at(&shapes, frame(16.), AT_TOP, |_| false);
    assert_eq!(built(&same), (0..=12).collect::<Vec<_>>());
    let changed = window.plan_at(&shapes, frame(20.), AT_TOP, |_| false);
    assert_eq!(built(&changed).len(), 40, "no size is known at 20 pt rems");
}

/// A row revealed is scrolled to by the least distance, in prepaint; the
/// rows are planned around where the list lands.
#[test]
fn a_reveal_plans_around_where_the_list_lands() {
    let spaces = vec![row(2., 30.); 100];
    // Row 99 (child 100) spans 3170..3200: at its bottom the list is
    // scrolled by 3200 - 320.
    let end = revealed(&spaces, Some(px(0.)), px(320.), px(0.), Some(100));
    assert_eq!(end, Some(px(-2880.)));
    // Row 0 above a list scrolled away brings its top to the list's top.
    let home = revealed(&spaces, Some(px(0.)), px(320.), px(-2880.), Some(1));
    assert_eq!(home, Some(px(-2.)));
    // A row already shown does not move the list; neither does no reveal.
    let shown = revealed(&spaces, Some(px(0.)), px(320.), px(0.), Some(5));
    assert_eq!(shown, Some(px(0.)));
    assert_eq!(
        revealed(&spaces, Some(px(0.)), px(320.), px(-50.), None),
        Some(px(-50.))
    );
    // The Home row (child 0) brings the list to its top.
    let top = revealed(&spaces, Some(px(40.)), px(320.), px(-900.), Some(0));
    assert_eq!(top, Some(px(0.)));
    // A row taller than the list shows its top.
    let tall = vec![row(2., 400.); 3];
    let at = revealed(&tall, Some(px(0.)), px(320.), px(0.), Some(2));
    assert_eq!(at, Some(px(-404.)));
}

#[test]
fn a_reveal_past_a_row_never_measured_builds_every_row() {
    let mut spaces = vec![row(2., 30.); 100];
    spaces[50] = None;
    assert_eq!(
        revealed(&spaces, Some(px(0.)), px(320.), px(0.), Some(80)),
        None
    );
    let window = RowWindow::default();
    let shapes: Vec<u64> = (0..100).collect();
    remembering(&window, &shapes[..40], 16.);
    let reveal = Frame {
        reveal: Some(80),
        ..frame(16.)
    };
    assert_eq!(
        built(&window.plan_at(&shapes, reveal, AT_TOP, |_| false)).len(),
        100
    );
}

#[test]
fn the_plan_follows_the_reveal_and_a_grown_window() {
    let shapes: Vec<u64> = (0..100).collect();
    let window = RowWindow::default();
    window.plan_at(&shapes, frame(16.), AT_TOP, |_| false);
    {
        let mut inner = window.0.borrow_mut();
        learn(&mut inner.sizes, &shapes, &laid_out(100));
        inner.viewport = Some(px(700.));
    }
    let end = Frame {
        reveal: Some(100),
        ..frame(16.)
    };
    // Scrolled by 2880 pt: rows 90..=99 show, and 87..=99 reach within the
    // margin.
    let rows = window.plan_at(&shapes, end, AT_TOP, |_| false);
    assert_eq!(built(&rows), (87..100).collect::<Vec<_>>());
    // The window grew by 320 pt, and the list with it: 640 pt plus 160.
    let grown = Frame {
        viewport: px(1020.),
        ..frame(16.)
    };
    let rows = window.plan_at(&shapes, grown, AT_TOP, |_| false);
    assert_eq!(built(&rows), (0..=24).collect::<Vec<_>>());
}
