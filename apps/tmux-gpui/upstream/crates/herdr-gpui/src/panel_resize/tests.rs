#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;

fn bounds(left: f32, width: f32) -> Bounds<Pixels> {
    Bounds::new(point(px(left), px(0.)), size(px(width), px(600.)))
}

#[test]
fn dragging_an_edge_follows_the_pointer_from_the_panel_s_far_side() {
    let mut notes = PanelWidth::new(300., 200.);
    assert_eq!((notes.width(0.), notes.chosen()), (300., None));
    // A right-hand panel at 900..1200 dragged by its left edge to 800.
    assert!(notes.drag(Side::Right, bounds(900., 300.), px(800.)));
    assert_eq!(notes.width(0.), 400.);
    assert!(
        !notes.drag(Side::Right, bounds(800., 400.), px(800.)),
        "unchanged"
    );
    // Never narrower than its minimum.
    notes.drag(Side::Right, bounds(800., 400.), px(1150.));
    assert_eq!(notes.width(0.), 200.);
    // A left-hand panel grows to the right.
    let mut navigation = PanelWidth::new(184., 140.);
    navigation.drag(Side::Left, bounds(0., 184.), px(260.));
    assert_eq!(navigation.width(0.), 260.);
    navigation.reset();
    assert_eq!((navigation.width(0.), navigation.chosen()), (184., None));
}

#[test]
fn a_panel_keeps_to_its_share_of_a_narrow_window() {
    let mut notes = PanelWidth::new(300., 200.);
    notes.restore(Some(900.));
    assert_eq!(notes.width(2000.), 900.);
    assert_eq!(notes.width(1000.), 600.);
    // The minimum holds while the window has room for it.
    assert_eq!(notes.width(300.), 200.);
    assert_eq!(notes.width(150.), 150.);
}

#[test]
fn saved_widths_are_checked_when_restored() {
    let mut notes = PanelWidth::new(300., 200.);
    notes.restore(Some(420.));
    assert_eq!(notes.chosen(), Some(420.));
    notes.restore(Some(50.));
    assert_eq!(notes.width(0.), 200.);
    for unusable in [f32::NAN, f32::INFINITY, -1., 0.] {
        notes.restore(Some(unusable));
        assert_eq!(notes.chosen(), None, "{unusable}");
    }
    notes.restore(Some(1e9));
    assert_eq!(notes.width(0.), MAX_WIDTH);
}
