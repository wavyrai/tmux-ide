#![allow(clippy::unwrap_used)]
use super::*;
use crate::{sidebar::layout_tests::fixture_window, state::ConnectionStatus, window::MockPeer};
use gpui::{Entity, VisualTestContext, point, px};
use herdr_client::protocol::{
    CellData, ClientShellSnapshot, FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect,
};
use serde_json::json;

const URL: &str = "https://example.com/wrapped/path";

fn snapshot() -> ClientShellSnapshot {
    serde_json::from_str(include_str!(
        "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap()
}

/// A 20-column pane whose URL soft-wraps onto its second row, which the
/// row-local detector does not read as a link.
fn wrapped(content_revision: u64) -> Arc<PaneSurfaceFrame> {
    let snapshot = snapshot();
    let (width, height) = (20, 4);
    let mut symbols = URL.chars();
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width,
        height,
    };
    Arc::new(PaneSurfaceFrame {
        boot_id: snapshot.boot_id,
        projection_revision: snapshot.revision,
        surface_revision: 1,
        frame: FrameData {
            width,
            height,
            cells: (0..usize::from(width) * usize::from(height))
                .map(|_| CellData {
                    symbol: symbols.next().unwrap_or(' ').to_string(),
                    fg: 0,
                    bg: 0,
                    modifier: 0,
                    skip: false,
                    hyperlink: None,
                })
                .collect(),
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![PaneSurfacePane {
            pane_id: "w1:p1".into(),
            content_revision,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: None,
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 200,
            pixel_height: 80,
        }],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    })
}

fn window<'a>(
    peer: &MockPeer,
    supported: bool,
    cx: &'a mut gpui::TestAppContext,
) -> (Entity<HerdrWindow>, &'a mut VisualTestContext) {
    let handle = peer.client.handle.clone();
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot()));
        view.live.surface = Some(wrapped(2));
        view.live.status = ConnectionStatus::Connected;
        view.live.supports_link_resolve = supported;
        view.live.supports_link_activate = supported;
        view.endpoints[view.selected_endpoint].connection.handle = Some(handle);
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    (view, cx)
}

/// The middle of pane cell (`col`, `row`).
fn at(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, col: u16, row: u16) -> Point<Pixels> {
    view.read_with(cx, |view, _| {
        let height = view.config.terminal.line_height();
        view.bounds.origin
            + point(
                px((f32::from(col) + 0.5) * view.cell_width),
                px((f32::from(row) + 0.5) * height),
            )
    })
}

/// Answers `request` with `result`, moves the client's event into the
/// link mailbox as the bridge's reader thread does, and lets the window
/// fold it in.
fn answer(
    peer: &mut MockPeer,
    view: &Entity<HerdrWindow>,
    cx: &mut VisualTestContext,
    request: &serde_json::Value,
    result: serde_json::Value,
) {
    let id = request["id"].as_str().unwrap();
    let event = peer.respond(
        &snapshot().boot_id,
        id,
        &json!({"id": id, "result": result}),
    );
    let links = view.read_with(cx, |view, _| {
        view.endpoints[view.selected_endpoint]
            .connection
            .links
            .clone()
    });
    assert!(links.lock().unwrap().apply(event).is_none());
    cx.update(|window, cx| view.update(cx, |view, cx| view.poll_links(window, cx)));
}

fn resolve_after_delay(cx: &mut VisualTestContext) {
    cx.executor().advance_clock(RESOLVE_DELAY * 2);
    cx.run_until_parked();
}

#[gpui::test]
fn a_wrapped_link_is_resolved_underlined_and_activated_by_the_daemon(
    cx: &mut gpui::TestAppContext,
) {
    let mut peer = MockPeer::advertising(&["pane.link.resolve", "pane.link.activate"]);
    let (view, cx) = window(&peer, true, cx);
    let continuation = at(&view, cx, 2, 1);
    view.read_with(cx, |view, _| {
        assert!(view.terminal_link_at(continuation).is_none());
    });

    // Movement within the delay leaves one request, for the latest cell.
    let elsewhere = at(&view, cx, 9, 2);
    cx.simulate_mouse_move(elsewhere, None, Modifiers::secondary_key());
    cx.simulate_mouse_move(continuation, None, Modifiers::secondary_key());
    resolve_after_delay(cx);
    let request = peer.request();
    assert_eq!(request["method"], "pane.link.resolve");
    assert_eq!(
        request["params"],
        json!({
            "pane_id": "w1:p1", "viewport_row": 1, "col": 2,
            "content_revision": 2, "offset_from_bottom": null,
        })
    );
    answer(
        &mut peer,
        &view,
        cx,
        &request,
        json!({"type": "pane_link_resolved", "regions": [
            {"row": 0, "start_col": 0, "end_col": 19},
            {"row": 1, "start_col": 0, "end_col": 11},
        ]}),
    );
    view.read_with(cx, |view, _| {
        let link = view.hovered_daemon_link().unwrap();
        assert_eq!(
            link.frame_rows().collect::<Vec<_>>(),
            vec![(0, 0..20), (1, 0..12)]
        );
        assert!(view.terminal_link_hovered(continuation, Modifiers::secondary_key()));
        assert!(view.link_modifier_held(continuation, Modifiers::secondary_key()));
    });

    // Moving along the link asks nothing new. A click goes to the daemon;
    // a plugin handler that claims it leaves nothing to open here.
    let first_row = at(&view, cx, 5, 0);
    cx.simulate_mouse_move(first_row, None, Modifiers::secondary_key());
    resolve_after_delay(cx);
    cx.simulate_click(continuation, Modifiers::secondary_key());
    let request = peer.request();
    assert_eq!(request["method"], "pane.link.activate");
    assert_eq!(request["params"]["viewport_row"], 1);
    assert_eq!(request["params"]["col"], 2);
    answer(
        &mut peer,
        &view,
        cx,
        &request,
        json!({"type": "pane_link_activated", "url": URL, "handled": true}),
    );
    assert!(cx.opened_url().is_none());

    // When nothing claims it, the whole wrapped address opens here.
    cx.simulate_click(continuation, Modifiers::secondary_key());
    let request = peer.request();
    assert_eq!(request["method"], "pane.link.activate");
    assert!(cx.opened_url().is_none());
    answer(
        &mut peer,
        &view,
        cx,
        &request,
        json!({"type": "pane_link_activated", "url": URL, "handled": false}),
    );
    assert_eq!(cx.opened_url().as_deref(), Some(URL));

    // New pane content hides the old answer and asks again, for the
    // content now shown.
    view.update(cx, |view, _| view.live.surface = Some(wrapped(4)));
    cx.update(|window, cx| view.update(cx, |view, cx| view.poll_links(window, cx)));
    view.read_with(cx, |view, _| assert!(view.hovered_daemon_link().is_none()));
    resolve_after_delay(cx);
    let request = peer.request();
    assert_eq!(request["method"], "pane.link.resolve");
    assert_eq!(request["params"]["content_revision"], 4);
    assert_eq!(request["params"]["viewport_row"], 1);

    // Releasing the modifier drops the hover; its answer arriving later
    // shows nothing.
    cx.simulate_mouse_move(continuation, None, Modifiers::default());
    answer(
        &mut peer,
        &view,
        cx,
        &request,
        json!({"type": "pane_link_resolved", "regions": [
            {"row": 1, "start_col": 0, "end_col": 11},
        ]}),
    );
    view.read_with(cx, |view, _| {
        assert!(view.hovered_daemon_link().is_none());
        assert!(!view.terminal_link_hovered(continuation, Modifiers::default()));
    });
}

#[gpui::test]
fn a_daemon_without_link_methods_keeps_the_local_detector(cx: &mut gpui::TestAppContext) {
    let peer = MockPeer::new();
    let (view, cx) = window(&peer, false, cx);
    let link = at(&view, cx, 2, 0);
    cx.simulate_mouse_move(link, None, Modifiers::secondary_key());
    resolve_after_delay(cx);
    view.read_with(cx, |view, _| {
        assert!(view.links.hover.is_none() && view.links.resolving.is_none());
    });
    // The row-local reading does not guess where a wrapped address
    // ends, so neither row is a link and nothing opens.
    let continuation = at(&view, cx, 2, 1);
    for position in [link, continuation] {
        view.read_with(cx, |view, _| {
            assert!(!view.terminal_link_hovered(position, Modifiers::secondary_key()));
            assert!(
                view.terminal_link_press(position, Modifiers::default())
                    .is_none()
            );
        });
        cx.simulate_click(position, Modifiers::secondary_key());
    }
    assert!(cx.opened_url().is_none());
}

#[gpui::test]
fn a_replaced_connection_retires_link_requests_unanswered(cx: &mut gpui::TestAppContext) {
    let mut peer = MockPeer::advertising(&["pane.link.resolve", "pane.link.activate"]);
    let (view, cx) = window(&peer, true, cx);
    let continuation = at(&view, cx, 2, 1);
    cx.simulate_mouse_move(continuation, None, Modifiers::secondary_key());
    resolve_after_delay(cx);
    assert_eq!(peer.request()["method"], "pane.link.resolve");
    view.update(cx, |view, _| {
        assert!(view.links.resolving.is_some());
        view.endpoints[view.selected_endpoint].connection.links = Arc::default();
        view.links.activating = Some(InFlight {
            id: "old".into(),
            inbox: Arc::default(),
            context: PendingActivation {
                fallback: WebUrl::try_from(URL).ok(),
                in_tab: false,
            },
        });
    });
    cx.update(|window, cx| view.update(cx, |view, cx| view.poll_links(window, cx)));
    view.read_with(cx, |view, _| {
        assert!(view.links.activating.is_none());
        assert!(view.hovered_daemon_link().is_none());
    });
    // The daemon may have run a handler for the old click, so nothing opens.
    assert!(cx.opened_url().is_none());
}
