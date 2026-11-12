//! The session table builds only the rows near the visible part of the page
//! (perf plan, finding 2), and nothing a user sees or does changes for it.
use super::*;
use crate::tmux_snapshot::home::fleet_nav;

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
