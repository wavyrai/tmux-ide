use super::*;

#[gpui::test]
fn connected_horizontal_wheel_reaches_only_mouse_reporting_panes_and_popups(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:wheel");
    let wheel = |position, delta| gpui::ScrollWheelEvent {
        position,
        delta,
        modifiers: gpui::Modifiers {
            shift: true,
            ..Default::default()
        },
        touch_phase: gpui::TouchPhase::Moved,
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare_mouse(view, endpoint, cx);
            Arc::make_mut(view.live.surface.as_mut().unwrap()).panes[1].mouse_reporting = false;
            let reporting = mouse_position(view, 3.5, 4.5);
            let plain = mouse_position(view, 45.5, 6.5);
            for (position, delta) in [
                (reporting, gpui::ScrollDelta::Lines(point(-2., 0.))),
                (reporting, gpui::ScrollDelta::Pixels(point(px(15.), px(0.)))),
                // Herdr drops a horizontal wheel without mouse reporting, but
                // still scrolls that pane's scrollback vertically.
                (plain, gpui::ScrollDelta::Lines(point(-3., 0.))),
                (plain, gpui::ScrollDelta::Lines(point(0., 1.))),
            ] {
                view.scroll_wheel(&wheel(position, delta), window, cx);
            }
            view.send(ClientPaneInputEvent::TextCommit("panes".into()), cx);

            let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
            surface.popup = Some(Box::new(ClientShellPopupSurface {
                terminal_id: "popup-wheel".into(),
                title: String::new(),
                width: None,
                height: None,
                frame: FrameData {
                    width: 20,
                    height: 10,
                    ..surface.frame.clone()
                },
                mouse_reporting: true,
                sgr_pixel_mouse: false,
                pixel_width: 400,
                pixel_height: 400,
            }));
            // The covered pane gets nothing; the popup gets its own position.
            for position in [reporting, mouse_position(view, 32.5, 10.5)] {
                view.scroll_wheel(
                    &wheel(position, gpui::ScrollDelta::Lines(point(1., 0.))),
                    window,
                    cx,
                );
            }
            view.send(ClientPaneInputEvent::TextCommit("popup".into()), cx);
        });
    });
    let scroll = |kind, column, row, lines| ClientPaneInputEvent::Mouse {
        kind,
        position: ClientMousePosition::Cell { column, row },
        geometry: None,
        modifiers: 1,
        lines,
    };
    for (pane_id, event) in [
        ("w1:p1", scroll(ClientMouseKind::ScrollRight, 2, 3, 2)),
        ("w1:p1", scroll(ClientMouseKind::ScrollLeft, 2, 3, 1)),
        ("w1:p2", scroll(ClientMouseKind::ScrollUp, 4, 5, 1)),
        ("w1:p1", ClientPaneInputEvent::TextCommit("panes".into())),
    ] {
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: pane_id.into(),
                events: vec![event],
            }
        );
    }
    for event in [
        scroll(ClientMouseKind::ScrollLeft, 2, 3, 1),
        ClientPaneInputEvent::TextCommit("popup".into()),
    ] {
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPopupInput {
                terminal_id: "popup-wheel".into(),
                events: vec![event],
            }
        );
    }
}
