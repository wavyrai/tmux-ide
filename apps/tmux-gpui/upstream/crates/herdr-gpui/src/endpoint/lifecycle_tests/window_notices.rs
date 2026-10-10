use super::*;

#[gpui::test]
fn system_notification_click_opens_its_origin_and_rejects_a_reconnect(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    // Unregistered windows, as in fixtures, never reach the notification center.
    let post = |view: &gpui::Entity<HerdrWindow>, cx: &mut gpui::VisualTestContext| {
        view.update_in(cx, |view, window, cx| {
            view.tick_toasts(false, Instant::now());
            view.post_system_notifications(window, cx);
        });
    };
    let (mut remote, _server) = connected_endpoint("ssh:notify");
    remote.initial_surface = false;
    let mut wire = crate::notifications::tests::notification("Agent needs attention");
    wire.workspace_id = Some("w1".into());
    wire.pane_id = Some("w1:p1".into());
    let notice = || {
        crate::notifications::Notice::new(wire.clone(), Instant::now())
            .with_snapshot(remote.live.snapshot.as_deref())
    };
    let (first, second) = (notice(), notice());
    view.update(cx, |view, _| {
        view.config.notifications = crate::config::NotificationConfig {
            enabled: false,
            system: true,
            delay_seconds: 0,
            ..Default::default()
        };
        view.endpoints[0].detached = true;
        remote.toasts.receive([first]);
        view.endpoints.push(remote);
    });
    post(&view, cx);
    assert!(cx.shown_system_notifications().is_empty());
    view.update(cx, |view, _| {
        assert!(
            view.endpoints[1]
                .toasts
                .entries
                .iter()
                .all(|(_, n)| !n.visible)
        );
    });

    cx.update(|_, cx| crate::window::system_notifications::install(cx));
    view.update(cx, |view, _| view.endpoints[1].toasts.receive([second]));
    post(&view, cx);
    let shown = cx.shown_system_notifications();
    let [shown] = shown.as_slice() else {
        panic!("expected one notification: {shown:?}");
    };
    assert_eq!(shown.tag, "herdr:ssh:notify:boot-v1:w1:p1");
    assert_eq!(shown.title, "Agent needs attention");
    assert_eq!(shown.body, "ssh:notify\nReview needed");
    assert!(shown.actions.is_empty());
    assert_eq!(
        cx.app_identity(),
        Some((crate::constants::APP_ID.into(), "Herdr".into()))
    );
    post(&view, cx);
    assert_eq!(cx.shown_system_notifications().len(), 1);

    let response = gpui::SystemNotificationResponse {
        tag: shown.tag.clone(),
        action_id: None,
    };
    cx.simulate_system_notification_response(response.clone());
    cx.run_until_parked();
    view.update(cx, |view, _| {
        assert_eq!(view.selected_endpoint, 1);
        assert_eq!(
            view.pending_navigation,
            Some(NavigationTarget::Pane("w1:p1".into()))
        );
        // A reconnect replaces the generation the click was posted for.
        view.selected_endpoint = 0;
        view.pending_navigation = None;
        view.pending_toast = None;
        view.endpoints[1].generation += 1;
    });
    cx.simulate_system_notification_response(response);
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.selected_endpoint, 0);
        assert!(view.pending_navigation.is_none());
    });
}

/// Bells and daemon titles travel the authoritative event path of each
/// connection, and only the selected endpoint's reach the window.
#[gpui::test]
fn bell_and_window_title_follow_the_selected_endpoint(cx: &mut gpui::TestAppContext) {
    let (local, mut local_server) = connected_endpoint("local-title");
    let (remote, mut remote_server) = connected_endpoint("ssh:title");
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.read_with(cx, |fixture, _| fixture.0.clone());
    view.update(cx, |view, cx| {
        view.endpoints = vec![local, remote];
        view.selected_endpoint = 0;
        view.reset_selected(cx);
    });
    let send = |server: &mut Server, message: ServerMessage| {
        write_message(&mut server.stream, &message, MAX_GRAPHICS_FRAME_SIZE).unwrap();
    };
    send(
        &mut remote_server,
        ServerMessage::WindowTitle {
            title: Some("remote\u{1b}]0;x\u{7} host".into()),
        },
    );
    send(&mut remote_server, ServerMessage::TerminalBell { count: 3 });
    send(
        &mut local_server,
        ServerMessage::WindowTitle {
            title: Some("local".into()),
        },
    );
    let ring_both = crate::config::BellConfig {
        attention: true,
        sound: true,
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            project_until(view, cx, "both titles", |view| {
                view.live.window_title.as_deref() == Some("local")
                    && view.endpoints[1].live.window_title.is_some()
            });
            // The remote bell was drained without ringing this window.
            assert_eq!(view.endpoints[1].live.bells, 0);
            assert_eq!(view.bell.take(ring_both, false, Instant::now()), None);
            assert_eq!(
                view.endpoints[1].live.window_title.as_deref(),
                Some("remote]0;x host")
            );
            view.sync_window_title(window);
            assert_eq!(view.title, "local");
        });
    });

    send(&mut local_server, ServerMessage::TerminalBell { count: 1 });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let deadline = Instant::now() + Duration::from_secs(3);
            let ring = loop {
                view.poll_endpoints(cx);
                if let Some(ring) = view.bell.take(ring_both, false, Instant::now()) {
                    break ring;
                }
                assert!(Instant::now() < deadline, "the local bell never rang");
                std::thread::sleep(Duration::from_millis(1));
            };
            assert!(ring.attention && ring.sound);

            // Switching endpoints takes that endpoint's title with it.
            view.selected_endpoint = 1;
            view.reset_selected(cx);
            view.live = view.endpoints[1].live.clone();
            view.sync_window_title(window);
            assert_eq!(view.title, "remote]0;x host");
        });
    });

    // Clearing restores the window's own title.
    send(
        &mut remote_server,
        ServerMessage::WindowTitle { title: None },
    );
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            project_until(view, cx, "cleared title", |view| {
                view.live.window_title.is_none()
            });
            view.sync_window_title(window);
            assert!(view.title.starts_with(crate::WINDOW_TITLE));
        });
    });
}
