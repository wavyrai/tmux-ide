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
