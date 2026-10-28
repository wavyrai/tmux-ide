use super::*;
use crate::{controls::Command, sidebar::layout_tests::fixture_window, window::MockPeer};
// `super::*` brings in gpui's `test`, which `#[gpui::test]` expands to.
use core::prelude::v1::test;
use gpui::{TestAppContext, VisualTestContext};
use herdr_client::{
    ClientEvent,
    protocol::{ClientMessage, PaneSurfaceScrollMetrics},
};
use serde_json::{Value, json};

mod tab_switch;

/// The next find or scroll request on the wire. Resizes and focus reports
/// may come first, and other requests are answered so they do not hold
/// the connection's one request slot; terminal input never may come.
fn next_request(peer: &mut MockPeer) -> Value {
    loop {
        match peer.receive() {
            ClientMessage::ClientShellEndpointRequest { boot_id, request } => {
                let request: Value = serde_json::from_str(&request).unwrap();
                if matches!(
                    request["method"].as_str(),
                    Some("pane.copy_search" | "pane.scroll")
                ) {
                    return request;
                }
                let id = request["id"].as_str().unwrap();
                peer.respond(&boot_id, id, &json!({"id": id, "result": {"type": "ok"}}));
            }
            message @ (ClientMessage::ClientShellPaneInput { .. }
            | ClientMessage::ClientShellPopupInput { .. }) => {
                panic!("find input reached the terminal: {message:?}")
            }
            _ => {}
        }
    }
}

/// Answers `request` over the wire and delivers the client's event the
/// way the connection's reader does, then lets the window poll.
fn answer(
    view: &Entity<HerdrWindow>,
    peer: &mut MockPeer,
    cx: &mut VisualTestContext,
    request: &Value,
    result: Value,
) {
    let id = request["id"].as_str().unwrap();
    let event = peer.respond("boot-v1", id, &json!({"id": id, "result": result}));
    assert!(matches!(&event, ClientEvent::Response { request_id, .. } if request_id == id));
    let inbox = view.read_with(cx, |view, _| {
        view.endpoints[0].connection.scrollback.clone()
    });
    assert!(
        inbox.lock().unwrap().apply(event).is_none(),
        "the scrollback inbox claims it"
    );
    cx.update(|window, cx| view.update(cx, |view, cx| view.poll_find(window, cx)));
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    methods: &[&str],
) -> (Entity<HerdrWindow>, MockPeer, &'a mut VisualTestContext) {
    let peer = MockPeer::advertising(methods);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        peer.prepare(&mut view, cx);
        view.live.supports_copy_search = methods.contains(&"pane.copy_search");
        let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
        // 100 rows of history above a 24-row screen, scrolled to the bottom.
        surface.panes[0].content_revision = 2;
        surface.panes[0].scroll = Some(PaneSurfaceScrollMetrics {
            offset_from_bottom: 0,
            max_offset_from_bottom: 100,
            viewport_rows: 24,
        });
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    (view, peer, cx)
}

fn find(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) {
    cx.update(|window, cx| view.update(cx, |view, cx| view.command(Command::Find, window, cx)));
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

fn label(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> String {
    view.read_with(cx, |view, _| view.find.as_ref().unwrap().search.label())
}

fn matches(rows: &[(u32, u16, u16)], current: u32, global: u64, total: u64) -> Value {
    json!({
        "type": "pane_copy_search",
        "pane_id": "w1:p1",
        "content_revision": 2,
        "matches": rows.iter().map(|(row, start, end)| json!({
            "start": {"row": row, "col": start},
            "end": {"row": row, "col": end},
        })).collect::<Vec<_>>(),
        "total": total,
        "current": current,
        "current_global": global,
    })
}

/// Typing goes to the field and becomes one search at a time; the
/// terminal sees none of it. An answer is counted, highlighted, and
/// scrolled into view, Enter moves to the next older match, and Escape
/// hands the keyboard back to the terminal.
#[gpui::test]
fn the_find_bar_searches_the_pane_without_typing_into_it(cx: &mut TestAppContext) {
    let (view, mut peer, cx) = open(cx, &["pane.copy_search", "pane.scroll"]);
    find(&view, cx);
    assert!(cx.debug_bounds("find-bar").is_some());
    assert!(cx.update(|window, cx| view.read(cx).find_focused(window, cx)));

    cx.simulate_keystrokes("x");
    let first = next_request(&mut peer);
    assert_eq!(first["method"], "pane.copy_search");
    assert_eq!(
        first["params"],
        json!({
            "pane_id": "w1:p1",
            "query": "x",
            "direction": "backward",
            // The bottom of the screen when the bar opened: 100 + 24.
            "cursor": {"row": 124, "col": 0},
            "content_revision": 2,
        })
    );
    // A second key waits for the first answer, which is then stale.
    cx.simulate_keystrokes("y");
    answer(&view, &mut peer, cx, &first, matches(&[(3, 0, 0)], 0, 0, 1));
    assert_eq!(
        label(&view, cx),
        "",
        "an answer to the old query is dropped"
    );
    let second = next_request(&mut peer);
    assert_eq!(second["params"]["query"], "xy");

    answer(
        &view,
        &mut peer,
        cx,
        &second,
        matches(&[(10, 2, 3), (110, 0, 1), (120, 4, 5)], 0, 0, 3),
    );
    assert_eq!(label(&view, cx), "1 of 3");
    // Row 10 is above the screen: centered, 12 rows put row 0 on top.
    let scroll = next_request(&mut peer);
    assert_eq!(scroll["method"], "pane.scroll");
    assert_eq!(
        scroll["params"],
        json!({"pane_id": "w1:p1", "offset_from_bottom": 100})
    );
    // The connection holds one request at a time; the scroll's answer
    // frees it for the next search.
    let id = scroll["id"].as_str().unwrap();
    peer.respond("boot-v1", id, &json!({"id": id, "result": {"type": "ok"}}));
    // Matches on screen are tinted in the frame's grid.
    let highlights = view.read_with(cx, |view, _| {
        view.find_highlights(view.live.surface.as_deref().unwrap())
    });
    assert_eq!(highlights.len(), 2);
    assert_eq!(highlights[0].row, 10);
    assert_eq!(highlights[1].row, 20);

    cx.simulate_keystrokes("enter");
    let older = next_request(&mut peer);
    assert_eq!(older["params"]["direction"], "backward");
    assert_eq!(
        older["params"]["previous"],
        json!({"start": {"row": 10, "col": 2}, "end": {"row": 10, "col": 3}})
    );
    cx.simulate_keystrokes("shift-enter");
    answer(
        &view,
        &mut peer,
        cx,
        &older,
        matches(&[(10, 2, 3), (110, 0, 1), (120, 4, 5)], 2, 2, 3),
    );
    assert_eq!(label(&view, cx), "3 of 3");
    let newer = next_request(&mut peer);
    assert_eq!(newer["params"]["direction"], "forward");

    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| assert!(view.find.is_none()));
    cx.update(|window, cx| {
        assert!(
            view.read(cx).focus.is_focused(window),
            "the terminal has the keyboard again"
        );
    });
}

#[gpui::test]
fn find_explains_an_old_daemon_instead_of_opening(cx: &mut TestAppContext) {
    let (view, _peer, cx) = open(cx, &["pane.scroll"]);
    find(&view, cx);
    view.read_with(cx, |view, _| {
        assert!(view.find.is_none());
        let (flash, _) = view.flash.clone().expect("Find says why it did nothing");
        assert_eq!(
            flash,
            crate::window::Flash::warning("Find needs a newer Herdr daemon")
        );
    });
}

/// A reconnect replaces the connection's mailbox; the bar opened on the
/// old one cannot be answered any more, so it closes.
#[gpui::test]
fn a_replaced_connection_retires_the_bar(cx: &mut TestAppContext) {
    let (view, _peer, cx) = open(cx, &["pane.copy_search"]);
    find(&view, cx);
    assert!(view.read_with(cx, |view, _| view.find.is_some()));
    // Cmd-F again keeps the bar on the same pane.
    find(&view, cx);
    assert!(view.read_with(cx, |view, _| view.find.is_some()));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.endpoints[0].connection.scrollback = Arc::default();
            view.poll_find(window, cx);
            assert!(view.find.is_none());
            assert!(view.focus.is_focused(window));
        })
    });
}
