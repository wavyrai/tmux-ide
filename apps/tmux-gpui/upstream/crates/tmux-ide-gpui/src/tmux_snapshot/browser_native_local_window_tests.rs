#![allow(clippy::unwrap_used)]
use super::*;

fn window(id: &str, active: bool, count: usize) -> InventoryWindow {
    InventoryWindow {
        id: id.into(),
        active,
        panes: (0..count).map(|i| format!("pane.{id}.{i}")).collect(),
    }
}
fn all(windows: &[InventoryWindow]) -> Vec<String> {
    windows.iter().flat_map(|w| w.panes.clone()).collect()
}

#[test]
fn a_session_that_fits_is_streamed_whole() {
    let windows = [window("one", true, 12), window("two", false, 12)];
    assert_eq!(scope(&all(&windows), Some(&windows), None), None);
}

#[test]
fn a_large_session_opens_its_active_window() {
    let windows = [window("one", false, 20), window("two", true, 10)];
    let scoped = scope(&all(&windows), Some(&windows), None).unwrap();
    assert_eq!(scoped.window, "two");
    assert_eq!(scoped.panes, windows[1].panes);
    assert_eq!(scoped.notice, None);
}

#[test]
fn a_selected_pane_opens_its_own_window() {
    let windows = [window("one", false, 20), window("two", true, 10)];
    let scoped = scope(&all(&windows), Some(&windows), Some("pane.one.3")).unwrap();
    assert_eq!((scoped.window.as_str(), scoped.notice), ("one", None));
    // A pane in no verified window wants the active one.
    let scoped = scope(&all(&windows), Some(&windows), Some("pane.gone")).unwrap();
    assert_eq!((scoped.window.as_str(), scoped.notice), ("two", None));
}

#[test]
fn a_window_too_large_is_passed_over_with_a_notice() {
    let windows = [
        window("one", false, 25),
        window("two", false, 24),
        window("three", true, 30),
    ];
    let scoped = scope(&all(&windows), Some(&windows), None).unwrap();
    assert_eq!(
        (scoped.window.as_str(), scoped.notice),
        ("two", Some(OTHER_WINDOW))
    );
    // A wanted pane's window too large: the active one, if it fits, instead.
    let windows = [window("one", false, 25), window("two", true, 3)];
    let scoped = scope(&all(&windows), Some(&windows), Some("pane.one.0")).unwrap();
    assert_eq!(
        (scoped.window.as_str(), scoped.notice),
        ("two", Some(OTHER_WINDOW))
    );
}

#[test]
fn no_fitting_window_or_no_windows_leaves_the_limit_to_refuse() {
    let windows = [window("one", true, 25), window("two", false, 26)];
    assert_eq!(scope(&all(&windows), Some(&windows), None), None);
    assert_eq!(scope(&all(&windows), None, None), None);
}

/// The wanted window too large and the active one fitting: the active one,
/// even when another fitting window comes first in tmux order.
#[test]
fn the_active_window_comes_before_the_first_that_fits() {
    let windows = [
        window("first", false, 3),
        window("wanted", false, 25),
        window("active", true, 5),
    ];
    let scoped = scope(&all(&windows), Some(&windows), Some("pane.wanted.0")).unwrap();
    assert_eq!(
        (scoped.window.as_str(), scoped.notice),
        ("active", Some(OTHER_WINDOW))
    );
}
