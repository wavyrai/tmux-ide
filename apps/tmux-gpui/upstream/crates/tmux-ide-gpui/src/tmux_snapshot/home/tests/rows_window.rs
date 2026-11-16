//! The session table builds only the rows near the visible part of the page
//! (perf plan, finding 2), and nothing a user sees or does changes for it.
use super::*;
use crate::tmux_snapshot::home::fleet_nav;
use std::{cell::Cell, rc::Rc};

/// One machine, one server, `count` sessions; every seventh is a favourite.
fn fleet(count: usize) -> browser::fleet::Fleet {
    let token =
        |n: u128| uuid::Uuid::from_u128(0x9990_0000_0000_4000_8000_0000_0000_0000 + n).to_string();
    let rows: Vec<serde_json::Value> = (0..count)
        .map(|i| {
            serde_json::json!({
                "id": format!("s{i}"), "name": format!("project-{i}"), "sessionId": format!("${i}"),
                "serverId": "default", "paneCount": 1, "windowCount": 1, "lastActivity": 0,
                "favorite": i % 7 == 0,
                "favoriteAction": token(1000 + i as u128), "selection": token(2000 + i as u128),
                "active": false})
        })
        .collect();
    serde_json::from_value(serde_json::json!({
        "preferences": {"revision": 1, "phase": "ready", "error": null}, "omittedGroups": 0,
        "groups": [{"id": "local", "label": "Local", "state": "ready", "conflict": false,
            "collapsed": false, "collapseAction": token(1), "omittedSessions": 0, "omittedServers": 0,
            "servers": [{"id": "default", "label": "default", "state": "online",
                "generation": token(2), "selection": token(3)}],
            "sessions": rows}]}))
    .unwrap()
}

fn open(
    cx: &mut TestAppContext,
    count: usize,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(256);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.sessions.clear();
        view.browser_state.fleet = Some(fleet(count));
        view
    });
    cx.simulate_resize(size(px(1200.), px(700.)));
    draw(cx);
    draw(cx);
    receiver.try_iter().for_each(drop);
    (view, cx, receiver)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

/// Delivers the next frame, which tests have no loop for.
fn next_frame(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
    });
    cx.run_until_parked();
}

fn built(cx: &mut VisualTestContext, row: usize) -> bool {
    cx.debug_bounds(Box::leak(format!("fleet-session-0-{row}").into_boxed_str()))
        .is_some()
}

fn page_extent(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> Pixels {
    view.read_with(cx, |v, _| {
        v.home_filter.as_ref().unwrap().page_scroll.max_offset().y
    })
}

#[gpui::test]
fn far_rows_are_spacers_and_the_page_keeps_its_length(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    assert!(built(cx, 0), "the first rows are on screen");
    assert!(!built(cx, 90), "row 90 is far below the page");
    let windowed = page_extent(&view, cx);
    // Build every row (a page with no height yet does) and compare.
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.home_filter.as_mut().unwrap().rows = Default::default();
        });
        window.draw(cx).clear(cx);
    });
    assert_eq!(
        page_extent(&view, cx),
        windowed,
        "spacers are as tall as rows"
    );
}

#[gpui::test]
fn scrolling_builds_rows_before_they_show(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    let page = cx.debug_bounds("tmux-home-page").unwrap();
    cx.simulate_event(ScrollWheelEvent {
        position: page.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-3000.))),
        modifiers: Modifiers::default(),
        touch_phase: TouchPhase::Moved,
    });
    draw(cx);
    let offset = view.read_with(cx, |v, _| {
        v.home_filter.as_ref().unwrap().page_scroll.offset().y
    });
    assert!(offset < px(-2000.), "scrolled: {offset:?}");
    // Every row now on screen is built, in its place.
    let shown: Vec<usize> = (0..100).filter(|row| built(cx, *row)).collect();
    assert!(!shown.is_empty());
    assert!(!built(cx, 0), "the top rows went back to a spacer");
    for row in &shown {
        let at = cx
            .debug_bounds(Box::leak(format!("fleet-session-0-{row}").into_boxed_str()))
            .unwrap();
        let next = cx.debug_bounds(Box::leak(
            format!("fleet-session-0-{}", row + 1).into_boxed_str(),
        ));
        if let Some(next) = next {
            assert_eq!(
                next.top() - at.top(),
                px(crate::tmux_snapshot::home::fleet::ROW_HEIGHT),
                "rows are contiguous"
            );
        }
    }
    let first = *shown.first().unwrap();
    let last = *shown.last().unwrap();
    let top = cx
        .debug_bounds(Box::leak(
            format!("fleet-session-0-{first}").into_boxed_str(),
        ))
        .unwrap();
    let bottom = cx
        .debug_bounds(Box::leak(
            format!("fleet-session-0-{last}").into_boxed_str(),
        ))
        .unwrap();
    assert!(
        top.top() <= page.top() && bottom.bottom() >= page.bottom(),
        "the page is covered"
    );
}

#[gpui::test]
fn the_keyboard_row_stays_built_off_screen(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let fleet = v.browser_state.fleet.clone().unwrap();
            let controls = v.home_filter.as_mut().unwrap();
            controls.table_cursor = Some(fleet_nav::row_key(&fleet, (0, 90)));
            controls.fleet_table.focus(window, cx);
        });
        window.draw(cx).clear(cx);
    });
    assert!(
        built(cx, 90),
        "the keyboard's row is built though off screen"
    );
    assert!(!built(cx, 80), "its neighbours are not");
}

#[gpui::test]
fn a_new_view_of_the_table_is_measured_again(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    // Favourites: rows 0, 7, 14, …, 98, in order, all near the top.
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.home_filter.as_mut().unwrap().fleet_view = fleet_nav::View::Favourites;
        });
        window.draw(cx).clear(cx);
        window.draw(cx).clear(cx);
    });
    let favourites: Vec<usize> = (0..100).filter(|row| built(cx, *row)).collect();
    assert_eq!(favourites, (0..100).step_by(7).collect::<Vec<_>>());
    let tops: Vec<Pixels> = favourites
        .iter()
        .map(|row| {
            cx.debug_bounds(Box::leak(format!("fleet-session-0-{row}").into_boxed_str()))
                .unwrap()
                .top()
        })
        .collect();
    assert!(
        tops.windows(2).all(|pair| pair[1] > pair[0]),
        "favourites keep their order"
    );
    // Back to All: the first rows are built again, where they belong.
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.home_filter.as_mut().unwrap().fleet_view = fleet_nav::View::All;
        });
        window.draw(cx).clear(cx);
        window.draw(cx).clear(cx);
    });
    assert!(built(cx, 0) && built(cx, 1) && !built(cx, 90));
}

/// A session that arrives while Home is open still fades in (#761, #746)
/// when its row is one of the built ones.
#[gpui::test]
fn an_arriving_row_still_enters(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    cx.update(|window, cx| {
        view.update(cx, |v, _| v.chrome.force_motion(false));
        window.draw(cx).clear(cx);
    });
    cx.background_executor
        .advance_clock(std::time::Duration::from_secs(1));
    draw(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let fleet = v.browser_state.fleet.as_mut().unwrap();
            let mut arriving = fleet.groups[0].sessions[1].clone();
            arriving.id = "arriving".into();
            fleet.groups[0].sessions.insert(0, arriving);
            cx.notify();
        });
        window.draw(cx).clear(cx);
    });
    let first = cx.debug_bounds("fleet-session-0-0").unwrap().top();
    cx.background_executor
        .advance_clock(std::time::Duration::from_millis(500));
    draw(cx);
    let settled = cx.debug_bounds("fleet-session-0-0").unwrap().top();
    assert_eq!(first, settled + px(crate::tmux_snapshot::motion::RISE));
    assert!(!built(cx, 95), "and far rows stay spacers");
}

/// When a run isn't where the last render assumed (the first frame, a new
/// table shape), the view renders again by itself; once it is, it doesn't.
#[gpui::test]
fn a_moved_run_renders_again_and_a_still_one_does_not(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    // Let the first measurement's own request play out.
    next_frame(cx);
    draw(cx);
    next_frame(cx);
    let renders = Rc::new(Cell::new(0));
    let seen = renders.clone();
    cx.update(|_, cx| {
        cx.observe(&view, move |_, _| seen.set(seen.get() + 1))
            .detach()
    });
    draw(cx);
    next_frame(cx);
    draw(cx);
    next_frame(cx);
    assert_eq!(renders.get(), 0, "a still table asks for nothing");
    // Forget where the runs were, as a new shape would move them, and
    // render: that render asks for one more once the runs are measured.
    view.update(cx, |v, cx| {
        v.home_filter.as_ref().unwrap().rows.forget();
        cx.notify();
    });
    draw(cx);
    next_frame(cx);
    assert!(
        renders.get() >= 2,
        "a moved run asks for another render: {}",
        renders.get()
    );
}

/// A page that grows (zoom, full screen, a display change) asks for another
/// render itself once it is laid out at its new size, so the rows that came
/// into view are built on the next frame, not left as spacers until
/// something else wakes the view (review of step 1).
#[gpui::test]
fn a_resized_page_asks_for_a_render_itself(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    next_frame(cx);
    draw(cx);
    next_frame(cx);
    draw(cx);
    assert!(!built(cx, 30), "row 30 is below a 700 pt page");
    let asked = |cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| v.home_filter.as_ref().unwrap().rows.asked())
    };
    let before = asked(cx);
    draw(cx);
    assert_eq!(asked(cx), before, "a still page asks for nothing");
    cx.simulate_resize(size(px(1200.), px(1800.)));
    // The frame the resize draws is planned against the old page.
    draw(cx);
    assert_eq!(
        asked(cx),
        before + 1,
        "the resized page asks for one render"
    );
    next_frame(cx);
    draw(cx);
    assert!(built(cx, 30), "and the rows now in view are built");
    let settled = asked(cx);
    draw(cx);
    assert_eq!(asked(cx), settled, "and then asks for nothing more");
}

/// VoiceOver must reach every row (PM requirement): while an assistive
/// client reads the window every row is built and is in the accessibility
/// tree, as before the table was windowed; when the client leaves the table
/// is windowed again.
#[gpui::test]
fn an_assistive_client_reads_every_row(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    assert!(!built(cx, 90), "row 90 starts as part of a spacer");
    let extent = page_extent(&view, cx);
    // gpui draws the window afresh when a client connects or leaves.
    let client = |cx: &mut VisualTestContext, on: bool| {
        cx.update(|window, cx| {
            window.set_a11y_active_for_test(on);
            window.draw(cx).clear(cx);
        });
    };
    client(cx, true);
    let missing: Vec<usize> = (0..100).filter(|row| !built(cx, *row)).collect();
    assert!(missing.is_empty(), "rows not built: {missing:?}");
    // What the tree holds of a row is its favourite button (the row itself
    // has no role, on main either).
    let tree = cx.update(|window, _| window.debug_a11y_tree_json().unwrap());
    let unread: Vec<usize> = (0..100)
        .filter(|row| !tree.contains(&format!(r#"NamedInteger(\"fleet-favorite\", {row})"#)))
        .collect();
    assert!(unread.is_empty(), "rows not in the tree: {unread:?}");
    assert_eq!(page_extent(&view, cx), extent, "the page is as long");
    client(cx, false);
    assert!(built(cx, 0));
    assert!(!built(cx, 90), "and windowed again once the client leaves");
}

/// Dragging the page's scrollbar thumb builds the rows it brings into view
/// on the drag's own frame. Every step of the drag notifies the view (in
/// the app the view is cached, and draws again only when notified), so the
/// render plans from the new offset. The quarter-page margin is not what
/// covers it: the drag here moves the page by more than two pages.
#[gpui::test]
fn dragging_the_scrollbar_builds_the_rows_it_shows(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    let page = cx.debug_bounds("tmux-home-page").unwrap();
    // The thumb shows while the pointer is over the page's edge.
    cx.simulate_mouse_move(
        point(page.right() - px(4.), page.top() + px(20.)),
        None,
        Modifiers::none(),
    );
    draw(cx);
    // The page's scrollbar thumb.
    let thumb = cx.debug_bounds("tmux-home-page-thumb").unwrap();
    let notified = Rc::new(Cell::new(0));
    let count = notified.clone();
    cx.update(|_, cx| {
        cx.observe(&view, move |_, _| count.set(count.get() + 1))
            .detach();
    });
    let offset = |cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| {
            v.home_filter.as_ref().unwrap().page_scroll.offset().y
        })
    };
    cx.simulate_mouse_down(thumb.center(), MouseButton::Left, Modifiers::none());
    let mut scrolled = 0;
    for step in 1..=8 {
        notified.set(0);
        let before = offset(cx);
        cx.simulate_mouse_move(
            thumb.center() + point(px(0.), px(50. * step as f32)),
            Some(MouseButton::Left),
            Modifiers::none(),
        );
        cx.run_until_parked();
        // The first move only starts the drag; each one after scrolls.
        if offset(cx) != before {
            scrolled += 1;
            assert!(notified.get() > 0, "drag step {step} notifies the view");
        }
    }
    assert!(
        scrolled >= 7,
        "the drag's moves scrolled the page: {scrolled}"
    );
    let offset = offset(cx);
    assert!(
        offset < -(page.size.height * 2.),
        "the drag scrolled the page by more than two pages: {offset:?}"
    );
    // The one frame the drag asked for, and no other wakeup.
    draw(cx);
    let first = (0..100).find(|row| built(cx, *row)).unwrap();
    let top = cx
        .debug_bounds(Box::leak(
            format!("fleet-session-0-{first}").into_boxed_str(),
        ))
        .unwrap()
        .top();
    let height = px(crate::tmux_snapshot::home::fleet::ROW_HEIGHT);
    let mut shown = 0;
    for row in 0..100 {
        let slot = top + height * (row as f32 - first as f32);
        if slot + height > page.top() && slot < page.bottom() {
            shown += 1;
            assert!(built(cx, row), "row {row} is on the page but a spacer");
        }
    }
    assert!(shown > 10, "the page shows rows: {shown}");
    assert!(!built(cx, 0), "the top rows went back to a spacer");
    cx.simulate_mouse_up(thumb.center(), MouseButton::Left, Modifiers::none());
}

/// With every row built for an assistive client no window of rows is
/// planned, so nothing re-plans after a resize: the page must still ask for
/// one render only, not one on every frame after (review of perf-paint).
#[gpui::test]
fn a_resize_with_every_row_built_asks_once(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    next_frame(cx);
    draw(cx);
    cx.update(|window, cx| {
        window.set_a11y_active_for_test(true);
        window.draw(cx).clear(cx);
    });
    let asked = |cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| v.home_filter.as_ref().unwrap().rows.asked())
    };
    next_frame(cx);
    draw(cx);
    let before = asked(cx);
    cx.simulate_resize(size(px(1200.), px(1800.)));
    draw(cx);
    for _ in 0..4 {
        next_frame(cx);
        draw(cx);
    }
    assert!(
        asked(cx) <= before + 1,
        "the page kept asking: {} renders",
        asked(cx) - before
    );
}

/// Each row is laid out as a root of its own and placed at its box: the
/// rows stack from the first one, a row apart, inside their machine's
/// block, wherever the page is scrolled.
#[gpui::test]
fn rows_sit_in_their_boxes(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    let height = px(crate::tmux_snapshot::home::fleet::ROW_HEIGHT);
    for offset in [0., -900.] {
        view.update(cx, |v, cx| {
            let page = &v.home_filter.as_ref().unwrap().page_scroll;
            page.set_offset(point(px(0.), px(offset)));
            cx.notify();
        });
        draw(cx);
        let bounds = |cx: &mut VisualTestContext, selector: String| {
            cx.debug_bounds(Box::leak(selector.into_boxed_str()))
        };
        let block = bounds(cx, "fleet-machine-0".into()).unwrap();
        let rows: Vec<(usize, Bounds<Pixels>)> = (0..100)
            .filter_map(|row| Some((row, bounds(cx, format!("fleet-session-0-{row}"))?)))
            .collect();
        assert!(rows.len() > 10, "rows are built: {}", rows.len());
        let (first, start) = rows[0];
        for (row, at) in &rows {
            assert_eq!(at.size.height, height, "row {row}");
            assert_eq!(
                at.top(),
                start.top() + height * (*row - first) as f32,
                "row {row} at offset {offset}"
            );
            assert_eq!(at.left(), start.left(), "row {row}");
        }
        // The block ends with its last row: 100 rows from the first's box.
        let end = start.top() + height * (100 - first) as f32;
        assert!(
            (block.bottom() - end).abs() < px(0.5),
            "the rows fill their block to its end: {:?} against {end:?}",
            block.bottom()
        );
    }
}
