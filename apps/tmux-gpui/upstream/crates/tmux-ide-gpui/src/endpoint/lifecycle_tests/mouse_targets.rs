use super::*;

#[gpui::test]
fn connected_mouse_focused_pane_preserves_drag_target_and_immediate_text(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for (button, wire_button) in [
        (MouseButton::Left, ClientMouseButton::Left),
        (MouseButton::Middle, ClientMouseButton::Middle),
        (MouseButton::Right, ClientMouseButton::Right),
    ] {
        let (endpoint, mut server) = connected_endpoint("ssh:mouse");
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                prepare_mouse(view, endpoint, cx);
                if button == MouseButton::Right {
                    // A right-click stays with the window until Herdr routes
                    // the pane's right-clicks to the application.
                    assert!(!view.terminal_mouse_down(
                        &MouseDownEvent {
                            position: mouse_position(view, 3.5, 4.5),
                            button,
                            ..Default::default()
                        },
                        window,
                        cx
                    ));
                    assert!(view.terminal_mouse.is_none());
                    Arc::make_mut(view.live.snapshot.as_mut().unwrap())
                        .panes
                        .iter_mut()
                        .filter(|pane| pane.pane_id == "w1:p1")
                        .for_each(|pane| pane.right_click_passthrough = true);
                }
                assert!(view.terminal_mouse_down(
                    &MouseDownEvent {
                        position: mouse_position(view, 3.5, 4.5),
                        button,
                        ..Default::default()
                    },
                    window,
                    cx
                ));
                assert!(view.input_ready());
                assert!(view.focus.is_focused(window));
                // Crossing another pane and leaving the canvas must stay on the pressed pane.
                assert!(view.terminal_mouse_move(
                    &MouseMoveEvent {
                        position: mouse_position(view, 45.5, 6.5),
                        pressed_button: Some(button),
                        ..Default::default()
                    },
                    cx
                ));
                assert!(view.terminal_mouse_up(
                    &MouseUpEvent {
                        position: mouse_position(view, 90., 30.),
                        button,
                        ..Default::default()
                    },
                    cx
                ));
                assert!(view.terminal_mouse.is_none());
                assert!(view.input_ready());
                assert!(view.live.activation.is_none());
                assert!(view.activation_deadline.is_none());
                view.send(ClientPaneInputEvent::TextCommit("immediate".into()), cx);
            });
        });
        for event in [
            mouse_event(ClientMouseKind::Down(wire_button), 2, 3),
            mouse_event(ClientMouseKind::Drag(wire_button), 37, 5),
            mouse_event(ClientMouseKind::Up(wire_button), 37, 21),
            ClientPaneInputEvent::TextCommit("immediate".into()),
        ] {
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellPaneInput {
                    pane_id: "w1:p1".into(),
                    events: vec![event],
                }
            );
        }
    }
}

#[gpui::test]
fn connected_mouse_inactive_pane_receives_first_click_before_focus_fence(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:mouse");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare_mouse(view, endpoint, cx);
            let position = mouse_position(view, 43.5, 4.5);
            assert!(view.terminal_mouse_down(
                &MouseDownEvent {
                    position,
                    button: MouseButton::Left,
                    ..Default::default()
                },
                window,
                cx
            ));
            assert!(view.input_ready());
            assert!(view.live.activation.is_none());
            assert!(view.mouse_focus_pending());
            view.send(
                ClientPaneInputEvent::TextCommit("must not reach old pane during press".into()),
                cx,
            );
            assert!(view.terminal_mouse_up(
                &MouseUpEvent {
                    position,
                    button: MouseButton::Left,
                    ..Default::default()
                },
                cx
            ));
            assert!(!view.input_ready());
            assert!(!view.mouse_focus_pending());
            assert!(view.live.activation.is_some());
            assert!(view.activation_deadline.is_some());
            view.send(
                ClientPaneInputEvent::TextCommit("must stay fenced".into()),
                cx,
            );
            view.endpoints[1]
                .connection
                .handle
                .as_ref()
                .unwrap()
                .set_focus(&snapshot().boot_id, false)
                .unwrap();
        });
    });
    for kind in [
        ClientMouseKind::Down(ClientMouseButton::Left),
        ClientMouseKind::Up(ClientMouseButton::Left),
    ] {
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p2".into(),
                events: vec![mouse_event(kind, 2, 3)],
            }
        );
    }
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("missing focus after the complete first click");
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], "pane.focus");
    assert_eq!(request["params"], serde_json::json!({"pane_id": "w1:p2"}));
    server.respond(&request);
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("missing ordered surface fence");
    };
    let barrier: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(barrier["method"], Method::ClientShellSurfaceSet.as_str());
    assert_eq!(barrier["params"]["active"], true);
    // The FIFO sentinel catches text incorrectly sent to the previously focused pane.
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    );
}

#[gpui::test]
fn connected_mouse_popup_uses_popup_relative_pixel_coordinates_and_blocks_covered_panes(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:mouse");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare_mouse(view, endpoint, cx);
            let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
            surface.popup = Some(Box::new(ClientShellPopupSurface {
                terminal_id: "popup-mouse".into(),
                title: String::new(),
                width: None,
                height: None,
                frame: FrameData {
                    width: 20,
                    height: 10,
                    ..surface.frame.clone()
                },
                mouse_reporting: true,
                sgr_pixel_mouse: true,
                pixel_width: 400,
                pixel_height: 400,
            }));
            let outside = mouse_position(view, 3.5, 4.5);
            assert!(!view.terminal_mouse_down(
                &MouseDownEvent {
                    position: outside,
                    button: MouseButton::Left,
                    ..Default::default()
                },
                window,
                cx
            ));
            assert!(!view.terminal_mouse_up(
                &MouseUpEvent {
                    position: outside,
                    button: MouseButton::Left,
                    ..Default::default()
                },
                cx
            ));
            let modifiers = gpui::Modifiers {
                control: true,
                alt: true,
                platform: true,
                ..Default::default()
            };
            // A 20x10 popup in an 80x24 surface starts at column 30, row 7.
            assert!(view.terminal_mouse_down(
                &MouseDownEvent {
                    position: mouse_position(view, 32.5, 10.5),
                    button: MouseButton::Left,
                    modifiers,
                    ..Default::default()
                },
                window,
                cx
            ));
            assert!(view.terminal_mouse_move(
                &MouseMoveEvent {
                    position: mouse_position(view, 34.5, 12.5),
                    pressed_button: Some(MouseButton::Left),
                    modifiers,
                },
                cx
            ));
            assert!(view.terminal_mouse_up(
                &MouseUpEvent {
                    position: mouse_position(view, 35.5, 13.5),
                    button: MouseButton::Left,
                    modifiers,
                    ..Default::default()
                },
                cx
            ));
            assert!(view.input_ready());
            assert!(view.live.activation.is_none());
            assert!(view.activation_deadline.is_none());
            view.send(ClientPaneInputEvent::TextCommit("popup text".into()), cx);
        });
    });
    for (kind, column, row, x, y) in [
        (
            ClientMouseKind::Down(ClientMouseButton::Left),
            2,
            3,
            50,
            140,
        ),
        (
            ClientMouseKind::Drag(ClientMouseButton::Left),
            4,
            5,
            90,
            220,
        ),
        (ClientMouseKind::Up(ClientMouseButton::Left), 5, 6, 110, 260),
    ] {
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPopupInput {
                terminal_id: "popup-mouse".into(),
                events: vec![ClientPaneInputEvent::Mouse {
                    kind,
                    position: ClientMousePosition::Pixels { x, y, column, row },
                    geometry: Some(ClientMouseGeometry {
                        cols: 20,
                        rows: 10,
                        width_px: 400,
                        height_px: 400
                    }),
                    modifiers: 14,
                    lines: 1,
                }],
            }
        );
    }
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPopupInput {
            terminal_id: "popup-mouse".into(),
            events: vec![ClientPaneInputEvent::TextCommit("popup text".into())],
        }
    );
}
