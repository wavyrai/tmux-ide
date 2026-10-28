use super::*;

fn split_request(server: &mut Server) -> serde_json::Value {
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("missing split ratio request");
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], "layout.set_split_ratio");
    request
}

#[gpui::test]
fn connected_split_drag_sends_coalesced_ratios_and_stops_on_layout_change(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:split");
    let down = |view: &mut HerdrWindow, column, cx: &mut Context<HerdrWindow>| {
        view.split_mouse_down(
            &MouseDownEvent {
                position: mouse_position(view, column, 5.5),
                button: MouseButton::Left,
                ..Default::default()
            },
            cx,
        )
    };
    let drag = |view: &mut HerdrWindow, column, cx: &mut Context<HerdrWindow>| {
        assert!(view.split_mouse_move(
            &MouseMoveEvent {
                position: mouse_position(view, column, 9.5),
                pressed_button: Some(MouseButton::Left),
                ..Default::default()
            },
            cx
        ));
    };
    let up = |view: &mut HerdrWindow, cx: &mut Context<HerdrWindow>| {
        assert!(view.split_mouse_up(
            &MouseUpEvent {
                position: mouse_position(view, 0., 0.),
                button: MouseButton::Left,
                ..Default::default()
            },
            cx
        ));
    };
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            prepare_mouse(view, endpoint, cx);
            Arc::make_mut(view.live.surface.as_mut().unwrap()).splits = vec![PaneSurfaceSplit {
                direction: PaneSurfaceSplitDirection::Horizontal,
                pos: 40,
                area: SurfaceRect {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 24,
                },
                hit_rect: SurfaceRect {
                    x: 40,
                    y: 0,
                    width: 1,
                    height: 24,
                },
                path: vec![true],
            }];
            // Projections of later answers must keep presenting this layout.
            let surface = view.live.surface.clone().unwrap();
            view.endpoints[1]
                .connection
                .inbox
                .lock()
                .unwrap()
                .apply(ClientEvent::Surface(surface));
            // Beside the border the pane keeps the pointer, even one that
            // reports mouse input; on it, the border wins.
            assert_eq!(view.split_cursor_at(mouse_position(view, 39.9, 5.)), None);
            assert!(!down(view, 39.9, cx));
            assert_eq!(
                view.split_cursor_at(mouse_position(view, 40.5, 5.)),
                Some(gpui::CursorStyle::ResizeLeftRight)
            );

            // A click on the border is not a resize.
            assert!(down(view, 40.5, cx));
            up(view, cx);
            assert!(view.split_drag.is_none());
            assert!(view.live.drag_request.is_none());

            // Pressed half a cell into the border, so the grab keeps that offset.
            assert!(down(view, 40.5, cx));
            assert!(view.terminal_mouse.is_none());
            drag(view, 20.5, cx);
            assert!(view.live.drag_request.is_some());
            // Later positions wait for that answer, and only the last is kept.
            drag(view, 60.5, cx);
            drag(view, 70.5, cx);
            // The pointer leaving the border keeps the cursor it grabbed.
            assert_eq!(
                view.split_cursor_at(mouse_position(view, 5., 5.)),
                Some(gpui::CursorStyle::ResizeLeftRight)
            );
        });
    });
    let first = split_request(&mut server);
    assert_eq!(
        first["params"],
        serde_json::json!({"tab_id": "w1:t1", "path": [true], "ratio": 0.25})
    );
    server.respond(&first);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            project_until(view, cx, "split answer", |view| {
                view.live.drag_request.is_none()
            });
            view.flush_split(cx);
            up(view, cx);
            // Released with the last ratio still unanswered.
            assert!(view.split_drag.is_some());
        });
    });
    let last = split_request(&mut server);
    assert_eq!(last["params"]["ratio"], serde_json::json!(0.875));
    server.respond(&last);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            project_until(view, cx, "last split answer", |view| {
                view.live.drag_request.is_none()
            });
            view.flush_split(cx);
            assert!(view.split_drag.is_none());
            assert_eq!(view.split_cursor_at(mouse_position(view, 5., 5.)), None);

            // A snapshot ahead of its surface is waited out.
            assert!(down(view, 40.5, cx));
            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).revision += 1;
            drag(view, 30.5, cx);
            assert!(view.split_drag.is_some());
            assert!(view.live.drag_request.is_none());
            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).revision -= 1;
            // A pane closing under the drag could move another border at the
            // same path, so the drag ends without sending.
            Arc::make_mut(view.live.surface.as_mut().unwrap()).panes[1].pane_id = "w1:p3".into();
            drag(view, 30.5, cx);
            assert!(view.split_drag.is_none());
            assert!(view.live.drag_request.is_none());
            assert!(view.local_error.is_none());
        });
    });
}
