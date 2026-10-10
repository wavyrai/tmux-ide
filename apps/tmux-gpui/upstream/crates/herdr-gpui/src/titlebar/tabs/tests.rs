#![allow(clippy::unwrap_used)]
use super::*;
use crate::titlebar::tests::header_window;
use core::prelude::v1::test;
use gpui::{Bounds, TestAppContext, VisualTestContext, point, px, size};
use herdr_client::protocol::ClientShellTabStatusSegment;

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        let _ = window.draw(cx);
    });
}

fn window(cx: &mut TestAppContext) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.simulate_resize(size(px(1200.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    (view, cx)
}

#[test]
fn only_the_strips_at_the_window_edges_carry_the_bar() {
    assert_eq!(
        Ends::of(0, 1),
        Ends {
            leading: true,
            trailing: true
        }
    );
    assert_eq!(
        (Ends::of(0, 3), Ends::of(1, 3), Ends::of(2, 3)),
        (
            Ends {
                leading: true,
                trailing: false
            },
            Ends::default(),
            Ends {
                leading: false,
                trailing: true
            },
        )
    );
}

#[gpui::test]
fn the_tab_row_stands_in_for_the_header(cx: &mut TestAppContext) {
    let (_, cx) = window(cx);
    assert!(cx.debug_bounds("titlebar").is_none());
    assert_eq!(cx.debug_bounds("window-body").unwrap().top(), px(0.));
    // The sidebar's first row clears the traffic lights and holds the toggle,
    // level with the tabs beside it.
    let header = cx.debug_bounds("sidebar-titlebar").unwrap();
    let sidebar = cx.debug_bounds("sidebar").unwrap();
    assert_eq!(header.origin, point(px(0.), px(0.)));
    assert_eq!(header.size, size(sidebar.size.width, px(HEIGHT)));
    assert_eq!(sidebar.top(), header.bottom());
    let toggle = cx.debug_bounds("toggle-sidebar").unwrap();
    assert_eq!(toggle.left(), px(LEADING));
    assert!(header.contains(&toggle.center()));
    assert!(cx.debug_bounds("strip-titlebar-leading").is_none());
    // The strip ends with the account at the window's right edge.
    let new_tab = cx.debug_bounds("new-tab").unwrap();
    assert_eq!(new_tab.top(), px(0.));
    assert_eq!(new_tab.size.height, px(HEIGHT));
    let trailing = cx.debug_bounds("strip-titlebar-trailing").unwrap();
    assert_eq!(trailing.right(), px(1200.));
    assert_eq!(
        cx.debug_bounds("titlebar-avatar").unwrap(),
        Bounds::new(point(px(1200. - 34.), px(3.)), size(px(28.), px(28.)))
    );
    let room = cx.debug_bounds("strip-titlebar-room").unwrap();
    assert!(room.size.width >= px(DRAG_ROOM));
    assert!(new_tab.right() <= room.left());
}

#[gpui::test]
fn a_collapsed_sidebar_hands_the_toggle_to_the_leftmost_strip(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    cx.update(|_, cx| view.update(cx, |view, _| view.toggle_sidebar()));
    for (mode, expected) in [("compact", Some(SidebarMode::Rail)), ("hidden", None)] {
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                view.settings.shared = Some(
                    crate::herdr_settings::Settings::parse_text(&format!(
                        "[ui]\nsidebar_collapsed_mode = '{mode}'"
                    ))
                    .unwrap(),
                );
                assert_eq!(
                    Some(view.sidebar_mode()),
                    expected.or(Some(SidebarMode::Hidden))
                );
                cx.notify();
            })
        });
        draw(cx);
        let toggle = cx.debug_bounds("toggle-sidebar").unwrap();
        let leading = cx.debug_bounds("strip-titlebar-leading").unwrap();
        assert!(leading.contains(&toggle.center()), "{mode}");
        assert_eq!(leading.top(), px(0.), "{mode}");
        // Clear of the traffic lights, whatever the column beside it covers.
        assert!(toggle.left() >= px(LEADING), "{mode}");
        if expected.is_none() {
            assert_eq!(toggle.left(), px(LEADING), "{mode}");
        }
    }
}

#[gpui::test]
fn a_split_puts_the_toggle_left_and_the_account_right(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.live.snapshot = Some(std::sync::Arc::new(
                serde_json::from_str(include_str!(
                    "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
                ))
                .unwrap(),
            ));
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.toggle_sidebar();
        })
    });
    draw(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let group = view.group_slots()[0].id;
            view.split_group(group, window, cx);
        })
    });
    cx.run_until_parked();
    draw(cx);
    let slots = view.read_with(cx, |view, _| view.group_slots());
    assert_eq!(slots.len(), 2);
    let left = cx.debug_bounds("group").unwrap();
    let right = cx.debug_bounds("g1-group").unwrap();
    assert!(left.contains(&cx.debug_bounds("toggle-sidebar").unwrap().center()));
    assert!(right.contains(&cx.debug_bounds("titlebar-avatar").unwrap().center()));
    assert!(cx.debug_bounds("titlebar").is_none());
}

#[gpui::test]
fn usage_fills_the_rightmost_drag_room(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.config.usage.topbar = true;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.tab_bar_right = vec![ClientShellTabStatusSegment {
                text: "Account usage 25% weekly 10%".into(),
                accent: false,
            }];
            cx.notify();
        })
    });
    draw(cx);
    let room = cx.debug_bounds("strip-titlebar-room").unwrap();
    let status = cx.debug_bounds("titlebar-status").unwrap();
    assert!(status.left() >= room.left() + px(DRAG_ROOM));
    assert!(status.right() <= room.right());
}

#[gpui::test]
fn a_bottom_tab_bar_keeps_the_header(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(header_window);
    cx.simulate_resize(size(px(1200.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    assert!(cx.debug_bounds("titlebar").is_some());
    for gone in [
        "sidebar-titlebar",
        "strip-titlebar-leading",
        "strip-titlebar-trailing",
        "strip-titlebar-room",
    ] {
        assert!(cx.debug_bounds(gone).is_none(), "{gone}");
    }
}
