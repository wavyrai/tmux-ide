use super::*;

#[gpui::test]
fn connected_mouse_cancels_stale_gestures_before_drag_or_release(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for change in [
        "epoch",
        "generation",
        "boot",
        "menu",
        "geometry",
        "reporting",
    ] {
        for move_first in [false, true] {
            let (endpoint, mut server) = connected_endpoint("ssh:mouse");
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    prepare_mouse(view, endpoint, cx);
                    let position = mouse_position(view, 3.5, 4.5);
                    assert!(view.terminal_mouse_down(
                        &MouseDownEvent {
                            position,
                            button: MouseButton::Left,
                            ..Default::default()
                        },
                        window,
                        cx
                    ));
                    assert!(view.terminal_mouse_move(
                        &MouseMoveEvent {
                            position: mouse_position(view, 5.5, 6.5),
                            pressed_button: Some(MouseButton::Left),
                            ..Default::default()
                        },
                        cx
                    ));
                    match change {
                        "epoch" => view.selection_epoch += 1,
                        "generation" => view.selected_generation += 1,
                        "boot" => {
                            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).boot_id =
                                "replacement".into();
                            Arc::make_mut(view.live.surface.as_mut().unwrap()).boot_id =
                                "replacement".into();
                        }
                        "menu" => view.open_keybinds(window, cx),
                        "geometry" => {
                            Arc::make_mut(view.live.surface.as_mut().unwrap()).panes[0]
                                .inner_rect
                                .width -= 1
                        }
                        "reporting" => {
                            Arc::make_mut(view.live.surface.as_mut().unwrap()).panes[0]
                                .mouse_reporting = false
                        }
                        _ => unreachable!(),
                    }
                    assert!(
                        view.input_ready(),
                        "isolate gesture cancellation from input readiness"
                    );
                    if move_first {
                        view.terminal_mouse_move(
                            &MouseMoveEvent {
                                position,
                                pressed_button: Some(MouseButton::Left),
                                ..Default::default()
                            },
                            cx,
                        );
                        assert!(view.terminal_mouse.is_none(), "{change}");
                    }
                    view.terminal_mouse_up(
                        &MouseUpEvent {
                            position,
                            button: MouseButton::Left,
                            ..Default::default()
                        },
                        cx,
                    );
                    assert!(view.terminal_mouse.is_none(), "{change}");
                    view.cancel_terminal_mouse(cx);
                    view.endpoints[1]
                        .connection
                        .handle
                        .as_ref()
                        .unwrap()
                        .set_focus(&snapshot().boot_id, false)
                        .unwrap();
                });
            });
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellPaneInput {
                    pane_id: "w1:p1".into(),
                    events: vec![mouse_event(
                        ClientMouseKind::Down(ClientMouseButton::Left),
                        2,
                        3
                    )],
                }
            );
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellPaneInput {
                    pane_id: "w1:p1".into(),
                    events: vec![mouse_event(
                        ClientMouseKind::Drag(ClientMouseButton::Left),
                        4,
                        5
                    )],
                }
            );
            if matches!(change, "menu" | "geometry" | "reporting") {
                // Cleanup uses the last sent drag, not the rejected move/release position.
                assert_eq!(
                    server.receive(),
                    ClientMessage::ClientShellPaneInput {
                        pane_id: "w1:p1".into(),
                        events: vec![mouse_event(
                            ClientMouseKind::Up(ClientMouseButton::Left),
                            4,
                            5
                        )],
                    }
                );
            }
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellFocus { focused: false },
                "{change}, move_first={move_first}"
            );
        }
    }
}

#[gpui::test]
fn connected_mouse_external_drag_cleans_up_once_without_forwarding_synthetic_input(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for pressed in [false, true] {
        for move_first in [false, true] {
            let (endpoint, mut server) = connected_endpoint("ssh:mouse");
            let position = cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    prepare_mouse(view, endpoint, cx);
                    let position = mouse_position(view, 3.5, 4.5);
                    if pressed {
                        assert!(view.terminal_mouse_down(
                            &MouseDownEvent {
                                position,
                                button: MouseButton::Left,
                                ..Default::default()
                            },
                            window,
                            cx
                        ));
                    }
                    mouse_position(view, 7.5, 8.5)
                })
            });
            // Use GPUI's real external-drag state; the nonrendering Fixture keeps resize out.
            cx.simulate_event(gpui::FileDropEvent::Entered {
                position,
                paths: gpui::ExternalPaths::default(),
            });
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    assert!(cx.has_active_drag());
                    if move_first {
                        assert!(!view.terminal_mouse_move(
                            &MouseMoveEvent {
                                position,
                                pressed_button: Some(MouseButton::Left),
                                ..Default::default()
                            },
                            cx
                        ));
                    }
                    assert!(!view.terminal_mouse_up(
                        &MouseUpEvent {
                            position,
                            button: MouseButton::Left,
                            ..Default::default()
                        },
                        cx
                    ));
                    assert!(view.terminal_mouse.is_none());
                    assert!(view.terminal_mouse_down(
                        &MouseDownEvent {
                            position,
                            button: MouseButton::Left,
                            ..Default::default()
                        },
                        window,
                        cx
                    ));
                    assert!(view.terminal_mouse.is_none());
                    view.terminal_mouse_hover(
                        &MouseMoveEvent {
                            position,
                            ..Default::default()
                        },
                        cx,
                    );
                    view.cancel_terminal_mouse(cx);
                    view.endpoints[1]
                        .connection
                        .handle
                        .as_ref()
                        .unwrap()
                        .set_focus(&snapshot().boot_id, false)
                        .unwrap();
                });
            });
            cx.simulate_event(gpui::FileDropEvent::Exited);
            if pressed {
                assert_eq!(
                    server.receive(),
                    ClientMessage::ClientShellPaneInput {
                        pane_id: "w1:p1".into(),
                        events: vec![mouse_event(
                            ClientMouseKind::Down(ClientMouseButton::Left),
                            2,
                            3
                        )],
                    }
                );
                assert_eq!(
                    server.receive(),
                    ClientMessage::ClientShellPaneInput {
                        pane_id: "w1:p1".into(),
                        events: vec![mouse_event(
                            ClientMouseKind::Up(ClientMouseButton::Left),
                            2,
                            3
                        )],
                    }
                );
            }
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellFocus { focused: false }
            );
        }
    }
}

#[gpui::test]
fn connected_mouse_deactivation_releases_last_sent_position_once_without_focusing(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for (offset, pane_id) in [(0., "w1:p1"), (40., "w1:p2")] {
        let (endpoint, mut server) = connected_endpoint("ssh:mouse");
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                prepare_mouse(view, endpoint, cx);
                view.active = true;
                assert!(view.terminal_mouse_down(
                    &MouseDownEvent {
                        position: mouse_position(view, offset + 3.5, 4.5),
                        button: MouseButton::Left,
                        ..Default::default()
                    },
                    window,
                    cx
                ));
                assert!(view.terminal_mouse_move(
                    &MouseMoveEvent {
                        position: mouse_position(view, offset + 5.5, 6.5),
                        pressed_button: Some(MouseButton::Left),
                        ..Default::default()
                    },
                    cx
                ));
                view.active = false;
                view.cancel_terminal_mouse(cx);
                view.cancel_terminal_mouse(cx);
                assert!(view.terminal_mouse.is_none());
                assert!(!view.mouse_focus_pending());
                assert!(!view.terminal_mouse_up(
                    &MouseUpEvent {
                        position: mouse_position(view, offset + 7.5, 8.5),
                        button: MouseButton::Left,
                        ..Default::default()
                    },
                    cx
                ));
                assert!(view.live.activation.is_none());
                assert!(view.activation_deadline.is_none());
                view.active = true;
                view.send(
                    ClientPaneInputEvent::TextCommit("after cancellation".into()),
                    cx,
                );
            });
        });
        for event in [
            mouse_event(ClientMouseKind::Down(ClientMouseButton::Left), 2, 3),
            mouse_event(ClientMouseKind::Drag(ClientMouseButton::Left), 4, 5),
            mouse_event(ClientMouseKind::Up(ClientMouseButton::Left), 4, 5),
        ] {
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellPaneInput {
                    pane_id: pane_id.into(),
                    events: vec![event],
                }
            );
        }
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p1".into(),
                events: vec![ClientPaneInputEvent::TextCommit(
                    "after cancellation".into()
                )],
            }
        );
    }
}

#[gpui::test]
fn connected_mouse_hover_is_separate_from_capture_and_obeys_input_guards(
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
            let event = MouseMoveEvent {
                position: mouse_position(view, 43.5, 4.5),
                ..Default::default()
            };
            assert!(!view.terminal_mouse_move(&event, cx));
            view.terminal_mouse_hover(&event, cx);
            view.terminal_mouse_hover(
                &MouseMoveEvent {
                    pressed_button: Some(MouseButton::Left),
                    ..event.clone()
                },
                cx,
            );
            view.terminal_mouse_hover(
                &MouseMoveEvent {
                    modifiers: gpui::Modifiers {
                        shift: true,
                        ..Default::default()
                    },
                    ..event.clone()
                },
                cx,
            );
            view.terminal_mouse_hover(
                &MouseMoveEvent {
                    position: mouse_position(view, 90., 30.),
                    ..event.clone()
                },
                cx,
            );
            Arc::make_mut(view.live.surface.as_mut().unwrap()).panes[1].mouse_reporting = false;
            view.terminal_mouse_hover(&event, cx);
            Arc::make_mut(view.live.surface.as_mut().unwrap()).panes[1].mouse_reporting = true;
            view.open_keybinds(window, cx);
            view.terminal_mouse_hover(&event, cx);
            view.menu.reset();
            assert!(view.terminal_mouse.is_none());
            assert!(view.live.activation.is_none());
            assert!(view.activation_deadline.is_none());
            view.send(
                ClientPaneInputEvent::TextCommit("hover does not focus".into()),
                cx,
            );
        });
    });
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p2".into(),
            events: vec![mouse_event(ClientMouseKind::Moved, 2, 3)],
        }
    );
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::TextCommit(
                "hover does not focus".into()
            )],
        }
    );
}
