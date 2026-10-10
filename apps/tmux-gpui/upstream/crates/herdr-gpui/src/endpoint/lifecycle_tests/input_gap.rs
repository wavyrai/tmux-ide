use super::*;

/// How the projection moves on while keys are typed between a newer snapshot
/// and its matching surface.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Gap {
    SameTarget,
    FocusMoves,
    PopupOpens,
}

/// Type `x` (IME commit) and Enter (key_down) during a snapshot/surface gap,
/// then close it and send a sentinel through the same path.
fn type_across_gap(
    cx: &mut gpui::TestAppContext,
    gap: Gap,
) -> (
    Server,
    gpui::Entity<HerdrWindow>,
    &mut gpui::VisualTestContext,
) {
    use gpui::EntityInputHandler;
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, server) = connected_endpoint("gap");
    let enter = gpui::KeyDownEvent {
        keystroke: gpui::Keystroke::parse("enter").unwrap(),
        is_held: false,
        prefer_character_input: false,
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare_mouse(view, endpoint, cx);
            let inbox = view.endpoints[1].connection.inbox.clone();
            let mut next = (**view.live.snapshot.as_ref().unwrap()).clone();
            next.revision += 1;
            if gap == Gap::FocusMoves {
                next.focused_pane_id = Some("w1:p2".into());
            }
            let mut frame = (**view.live.surface.as_ref().unwrap()).clone();
            frame.projection_revision = next.revision;
            if gap == Gap::PopupOpens {
                frame.popup = Some(Box::new(ClientShellPopupSurface {
                    terminal_id: "popup-1".into(),
                    title: String::new(),
                    width: None,
                    height: None,
                    frame: frame.frame.clone(),
                    mouse_reporting: false,
                    sgr_pixel_mouse: false,
                    pixel_width: 800,
                    pixel_height: 480,
                }));
            }
            inbox
                .lock()
                .unwrap()
                .apply(ClientEvent::Snapshot(Arc::new(next)));
            project_until(view, cx, "newer snapshot", |view| !view.input_ready());
            view.replace_text_in_range(None, "x", window, cx);
            view.key_down(&enter, window, cx);
            assert_eq!(view.pending_input.len(), 2);
            inbox
                .lock()
                .unwrap()
                .apply(ClientEvent::Surface(Arc::new(frame)));
            project_until(view, cx, "matching surface", HerdrWindow::input_ready);
            assert_eq!(view.pending_input.len(), 0);
            view.send(ClientPaneInputEvent::TextCommit("sentinel".into()), cx);
        });
    });
    (server, view, cx)
}

fn pane_input(pane: &str, event: ClientPaneInputEvent) -> ClientMessage {
    ClientMessage::ClientShellPaneInput {
        pane_id: pane.into(),
        events: vec![event],
    }
}

#[gpui::test]
fn input_typed_during_snapshot_surface_gap_reaches_pane_once_in_order(
    cx: &mut gpui::TestAppContext,
) {
    let (mut server, view, cx) = type_across_gap(cx, Gap::SameTarget);
    let enter = crate::terminal::key_input(
        &gpui::KeyDownEvent {
            keystroke: gpui::Keystroke::parse("enter").unwrap(),
            is_held: false,
            prefer_character_input: false,
        },
        false,
    )
    .unwrap();
    for expected in [
        ClientPaneInputEvent::TextCommit("x".into()),
        enter,
        ClientPaneInputEvent::TextCommit("sentinel".into()),
    ] {
        assert_eq!(server.receive(), pane_input("w1:p1", expected));
    }
    view.read_with(cx, |view, _| assert!(view.local_error.is_none()));
}

#[gpui::test]
fn input_held_across_gap_is_discarded_when_focus_moves(cx: &mut gpui::TestAppContext) {
    let (mut server, view, cx) = type_across_gap(cx, Gap::FocusMoves);
    assert_eq!(
        server.receive(),
        pane_input("w1:p2", ClientPaneInputEvent::TextCommit("sentinel".into()))
    );
    view.read_with(cx, |view, _| assert!(view.local_error.is_some()));
}

#[gpui::test]
fn input_held_across_gap_never_reaches_a_popup_that_opened(cx: &mut gpui::TestAppContext) {
    let (mut server, view, cx) = type_across_gap(cx, Gap::PopupOpens);
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPopupInput {
            terminal_id: "popup-1".into(),
            events: vec![ClientPaneInputEvent::TextCommit("sentinel".into())],
        }
    );
    view.read_with(cx, |view, _| assert!(view.local_error.is_some()));
}

#[gpui::test]
fn input_held_across_gap_is_bounded_and_dropped_on_reset(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, _server) = connected_endpoint("bound");
    view.update(cx, |view, cx| {
        prepare_mouse(view, endpoint, cx);
        view.poll_endpoints(cx);
        let mut next = (**view.live.snapshot.as_ref().unwrap()).clone();
        next.revision += 1;
        view.endpoints[1]
            .connection
            .inbox
            .lock()
            .unwrap()
            .apply(ClientEvent::Snapshot(Arc::new(next)));
        project_until(view, cx, "newer snapshot", |view| !view.input_ready());
        for _ in 0..300 {
            view.send(ClientPaneInputEvent::TextCommit("x".into()), cx);
        }
        assert_eq!(view.pending_input.len(), 256);
        assert!(view.local_error.is_some());
        view.reset_selected(cx);
        assert_eq!(view.pending_input.len(), 0);
    });
}
