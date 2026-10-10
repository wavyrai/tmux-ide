use super::*;

/// A double click copies the word under it and a triple click its row,
/// through the same release that copies a drag.
#[gpui::test]
fn double_and_triple_clicks_copy_the_word_and_the_row(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut frame = surface(&["cat src/lib.rs now", "next"], 20);
        let snapshot = view.live.snapshot.as_ref().unwrap();
        frame.boot_id = snapshot.boot_id.clone();
        frame.projection_revision = snapshot.revision;
        view.live.surface = Some(Arc::new(frame));
        view
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let (origin, cell) = view.read_with(cx, |view, _| {
        (
            view.bounds.origin,
            (view.cell_width, view.config.terminal.line_height()),
        )
    });
    let position = origin + point(px(6.5 * cell.0), px(0.5 * cell.1));
    let clipboard = |cx: &mut gpui::VisualTestContext| {
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()))
    };
    for (click_count, expected) in [(2, "src/lib.rs"), (3, "cat src/lib.rs now")] {
        cx.simulate_event(gpui::MouseDownEvent {
            button: MouseButton::Left,
            position,
            modifiers: Modifiers::default(),
            click_count,
            first_mouse: false,
        });
        cx.simulate_mouse_up(position, MouseButton::Left, Modifiers::default());
        assert_eq!(clipboard(cx), Some(expected.into()));
        view.read_with(cx, |view, _| assert!(view.selection_retained()));
    }
}

/// A drag held above a scrollable pane scrolls it one request at a time,
/// and a selection that ends up reaching rows off the screen is read
/// from the daemon on release instead of from the painted cells.
#[gpui::test]
fn a_drag_past_the_pane_scrolls_and_copies_through_the_daemon(cx: &mut TestAppContext) {
    use crate::window::MockPeer;
    use serde_json::{Value, json};
    let mut peer = MockPeer::advertising(&["pane.scroll", "pane.selection.read"]);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        peer.prepare(&mut view, cx);
        view.live.supports_selection_read = true;
        let frame = surface(&["x"; 24], 80);
        let live = Arc::make_mut(view.live.surface.as_mut().unwrap());
        live.frame = frame.frame;
        live.panes[0].mouse_reporting = false;
        live.panes[0].scroll = Some(PaneSurfaceScrollMetrics {
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
    let (origin, cell) = view.read_with(cx, |view, _| {
        (
            view.bounds.origin,
            (view.cell_width, view.config.terminal.line_height()),
        )
    });
    let at = |column: f32, row: f32| origin + point(px(column * cell.0), px(row * cell.1));
    let next_request = |peer: &mut MockPeer| -> Value {
        loop {
            if let ClientMessage::ClientShellEndpointRequest { request, .. } = peer.receive() {
                let request: Value = serde_json::from_str(&request).unwrap();
                if matches!(
                    request["method"].as_str(),
                    Some("pane.scroll" | "pane.selection.read")
                ) {
                    return request;
                }
                let id = request["id"].as_str().unwrap();
                peer.respond("boot-v1", id, &json!({"id": id, "result": {"type": "ok"}}));
            }
        }
    };

    // Press on row 5 (content row 105) and hold the pointer two rows
    // above the pane.
    cx.simulate_mouse_down(at(3.2, 5.5), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(at(3.2, -1.5), MouseButton::Left, Modifiers::default());
    view.update(cx, |view, cx| view.follow_selection(cx));
    let scroll = next_request(&mut peer);
    assert_eq!(scroll["method"], "pane.scroll");
    assert_eq!(
        scroll["params"],
        json!({"pane_id": "w1:p1", "offset_from_bottom": 2})
    );
    // The next step waits for this one's answer.
    view.update(cx, |view, cx| {
        view.selection_follow.scrolled = None;
        view.follow_selection(cx);
        assert!(view.live.drag_request.is_some());
    });

    // The daemon answers, having scrolled the pane well up by now: the
    // selection follows the still pointer to the new top row, 45 rows
    // above where it started.
    let id = scroll["id"].as_str().unwrap();
    peer.respond("boot-v1", id, &json!({"id": id, "result": {"type": "ok"}}));
    view.update(cx, |view, cx| {
        view.live.drag_request = None;
        let live = Arc::make_mut(view.live.surface.as_mut().unwrap());
        live.panes[0].scroll.as_mut().unwrap().offset_from_bottom = 40;
        view.selection_follow.scrolled = None;
        view.follow_selection(cx);
    });
    // Still held above the pane, it keeps going from where the pane is.
    let again = next_request(&mut peer);
    assert_eq!(again["params"]["offset_from_bottom"], 42);
    let id = again["id"].as_str().unwrap();
    peer.respond("boot-v1", id, &json!({"id": id, "result": {"type": "ok"}}));
    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("before".into())));
    cx.simulate_mouse_up(at(3.2, -1.5), MouseButton::Left, Modifiers::default());
    let read = next_request(&mut peer);
    assert_eq!(read["method"], "pane.selection.read");
    assert_eq!(
        read["params"],
        json!({
            "pane_id": "w1:p1",
            "anchor": {"row": 60, "col": 0},
            "cursor": {"row": 105, "col": 2},
        })
    );
    view.read_with(cx, |view, _| {
        assert!(view.selection.as_ref().is_some_and(|s| !s.dragging()))
    });

    // The answer, delivered as the connection's reader does, is copied.
    let id = read["id"].as_str().unwrap();
    let event = peer.respond(
        "boot-v1",
        id,
        &json!({"id": id, "result": {"type": "pane_selection",
            "pane_id": "w1:p1", "text": "from the history"}}),
    );
    let inbox = view.read_with(cx, |view, _| {
        view.endpoints[0].connection.scrollback.clone()
    });
    assert!(inbox.lock().unwrap().apply(event).is_none());
    view.update(cx, |view, cx| view.follow_selection(cx));
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("from the history".into())
    );
    view.read_with(cx, |view, _| {
        assert!(view.flash.is_some());
        assert!(view.selection_follow.read.is_none());
    });
}
