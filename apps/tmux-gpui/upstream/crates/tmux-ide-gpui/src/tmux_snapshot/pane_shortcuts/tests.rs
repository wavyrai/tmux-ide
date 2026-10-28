#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
#[test]
fn only_exact_application_chords_are_reserved() {
    for (key, expected) in [
        ("cmd-shift-enter", Shortcut::Zoom),
        ("cmd-alt-left", Shortcut::Focus(0)),
        ("cmd-alt-down", Shortcut::Focus(3)),
    ] {
        assert_eq!(shortcut(&Keystroke::parse(key).unwrap()), Some(expected));
    }
    for key in [
        "enter",
        "shift-enter",
        "alt-left",
        "cmd-enter",
        "cmd-alt-shift-left",
        "ctrl-cmd-alt-left",
    ] {
        assert_eq!(shortcut(&Keystroke::parse(key).unwrap()), None);
    }
}
#[test]
fn adjacent_panes_follow_geometry_without_wrapping() {
    let r = |id: &str, left, top, width, height| Region {
        id: id.into(),
        left,
        top,
        width,
        height,
    };
    let regions = [
        r("left", 0, 0, 20, 40),
        r("upper", 21, 0, 20, 19),
        r("lower", 21, 20, 20, 20),
    ];
    assert_eq!(neighbor(&regions, "upper", 0), Some("left"));
    assert_eq!(neighbor(&regions, "upper", 3), Some("lower"));
    assert_eq!(neighbor(&regions, "lower", 2), Some("upper"));
    assert_eq!(neighbor(&regions, "left", 0), None);
    assert_eq!(neighbor(&regions, "missing", 0), None);
    assert_eq!(neighbor(&regions, "lower", 1), None);
}
