use super::*;

#[gpui::test]
fn toast_navigation_queues_typed_targets_and_fences_input(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for (tab, pane, method, params) in [
        (
            None,
            None,
            "workspace.focus",
            serde_json::json!({"workspace_id":"w1"}),
        ),
        (
            Some("w1:t1"),
            None,
            "tab.focus",
            serde_json::json!({"tab_id":"w1:t1"}),
        ),
        (
            Some("w1:t1"),
            Some("w1:p1"),
            "pane.focus",
            serde_json::json!({"pane_id":"w1:p1"}),
        ),
    ] {
        let (mut endpoint, mut server) = connected_endpoint("ssh:toast");
        let mut wire = crate::notifications::tests::notification("Navigate");
        wire.workspace_id = Some("w1".into());
        wire.tab_id = tab.map(str::to_owned);
        wire.pane_id = pane.map(str::to_owned);
        endpoint
            .toasts
            .receive([crate::notifications::Notice::new(wire, Instant::now())
                .with_snapshot(endpoint.live.snapshot.as_deref())
                .preview()]);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.endpoints.truncate(1);
                view.endpoints.push(endpoint);
                view.selected_endpoint = 1;
                view.options = ConnectOptions::default();
                view.reset_selected(cx);
                window.focus(&view.focus, cx);
                view.marked = "composition".into();
                assert!(view.input_ready());
                view.tick_toasts(false, Instant::now());
                view.command(Command::OpenNotificationTarget, window, cx);
                assert!(view.endpoints[1].toasts.entries.is_empty());
                assert!(view.marked.is_empty());
                assert!(view.focus.is_focused(window));
                assert!(!view.input_ready());
            })
        });
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("expected semantic focus request")
        };
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["method"], method);
        assert_eq!(request["params"], params);
    }
}

#[gpui::test]
fn wire_completion_waits_for_evidence_then_command_uses_original_pane(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (mut endpoint, mut server) = connected_endpoint("ssh:completion");
    let mut projection = snapshot();
    projection.revision += 1;
    projection.agents[0].agent_status = AgentStatus::Working;
    write_message(
        &mut server.stream,
        &ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: serde_json::to_string(&projection).unwrap(),
        },
        MAX_GRAPHICS_FRAME_SIZE,
    )
    .unwrap();
    let mut event = crate::notifications::tests::notification("wire completion");
    event.kind = SemanticNotificationKind::Finished;
    event.workspace_id = None;
    event.pane_id = Some("w1:p1".into());
    write_message(
        &mut server.stream,
        &ServerMessage::SemanticNotification(event),
        MAX_GRAPHICS_FRAME_SIZE,
    )
    .unwrap();
    wait_until(|| {
        endpoint.poll(Instant::now());
        !endpoint.toasts.entries.is_empty()
    });
    let now = Instant::now();
    view.update(cx, |view, _| {
        view.endpoints.push(endpoint);
        view.config.notifications.enabled = true;
        view.config.notifications.delay_seconds = 0;
        view.tick_toasts(false, now);
        assert!(!view.endpoints[1].toasts.entries[0].1.visible);
    });
    projection.revision += 1;
    projection.agents[0].agent_status = AgentStatus::Done;
    write_message(
        &mut server.stream,
        &ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: serde_json::to_string(&projection).unwrap(),
        },
        MAX_GRAPHICS_FRAME_SIZE,
    )
    .unwrap();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            wait_until(|| {
                view.endpoints[1].poll(Instant::now());
                view.endpoints[1]
                    .live
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| s.revision == projection.revision)
            });
            view.tick_toasts(false, now + Duration::from_millis(50));
            assert!(view.endpoints[1].toasts.entries[0].1.visible);
            view.endpoints[1]
                .connection
                .inbox
                .lock()
                .unwrap()
                .apply(ClientEvent::Surface(surface(&projection)));
            wait_until(|| {
                view.endpoints[1].poll(Instant::now());
                view.endpoints[1].live.surface.is_some()
            });
            // Select the already-active fixture surface without issuing unrelated activation requests.
            view.selected_endpoint = 1;
            view.reset_selected(cx);
            view.command(Command::OpenNotificationTarget, window, cx);
            assert!(view.endpoints[1].toasts.entries.is_empty());
            assert!(!view.input_ready());
        })
    });
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("expected completion target focus");
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], "pane.focus");
    assert_eq!(request["params"]["pane_id"], "w1:p1");
}

#[gpui::test]
fn toast_click_uses_origin_and_close_never_navigates(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let (mut remote, _server) = connected_endpoint("ssh:toast");
    remote.initial_surface = false;
    let mut wire = crate::notifications::tests::notification("Remote target");
    wire.workspace_id = Some("w1".into());
    let notice = crate::notifications::Notice::new(wire, Instant::now())
        .with_snapshot(remote.live.snapshot.as_deref())
        .preview();
    remote.toasts.receive([notice.clone(), notice]);
    cx.simulate_resize(size(px(1000.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // The same IDs on Local must not win over the notification's origin.
            view.endpoints[0].live.snapshot = remote.live.snapshot.clone();
            view.endpoints[0].detached = true;
            view.endpoints.push(remote);
            window.focus(&view.focus, cx);
            view.marked = "composition".into();
        });
        window.draw(cx).clear(cx);
    });
    let dismiss = cx.debug_bounds("toast-dismiss-ssh:toast-0").unwrap();
    cx.simulate_click(dismiss.center(), Default::default());
    cx.update(|window, cx| {
        let view = view.read(cx);
        assert_eq!(view.selected_endpoint, 0);
        assert!(view.pending_navigation.is_none());
        assert_eq!(view.marked, "composition");
        assert!(view.focus.is_focused(window));
        assert_eq!(view.endpoints[1].toasts.entries.len(), 1);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let card = cx.debug_bounds("toast-ssh:toast-1").unwrap();
    cx.simulate_click(card.center(), Default::default());
    view.update(cx, |view, _| {
        assert_eq!(view.selected_endpoint, 1);
        assert_eq!(view.pending_toast, Some(1));
        assert_eq!(
            view.pending_navigation,
            Some(NavigationTarget::Workspace("w1".into()))
        );
        assert_eq!(view.endpoints[1].toasts.entries.len(), 1);
        // A newer inbox boot is rejected even before it reaches the UI projection.
        let inbox = view.endpoints[1].connection.inbox.clone();
        {
            let mut state = inbox.lock().unwrap();
            Arc::make_mut(state.snapshot.as_mut().unwrap()).boot_id = "replacement".into();
        }
        assert_eq!(view.toast_target(1, 1), std::task::Poll::Ready(None));
        view.endpoints[1].stop();
        assert_eq!(view.toast_target(1, 1), std::task::Poll::Ready(None));
    });
}

#[gpui::test]
fn toast_rendered_clicks_reject_replaced_removed_and_disabled_origins(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.simulate_resize(size(px(1000.), px(600.)));
    for change in 0..4 {
        let (mut remote, _server) = connected_endpoint("ssh:toast");
        let mut wire = crate::notifications::tests::notification("old render");
        wire.workspace_id = Some("w1".into());
        remote
            .toasts
            .receive([crate::notifications::Notice::new(wire, Instant::now())
                .with_snapshot(remote.live.snapshot.as_deref())
                .preview()]);
        cx.update(|window, cx| {
            view.update(cx, |view, _| {
                view.endpoints.truncate(1);
                view.endpoints.push(remote);
            });
            window.draw(cx).clear(cx);
        });
        assert!(cx.debug_bounds("toast-ssh:toast-0").is_some());
        let (generation, inbox) = view.read_with(cx, |view, _| {
            (
                view.endpoints[1].generation,
                view.endpoints[1].connection.inbox.clone(),
            )
        });
        view.update(cx, |view, _| match change {
            0 => view.endpoints[1].generation += 1,
            1 => {
                view.endpoints[1].connection.inbox =
                    Arc::new(Mutex::new(view.endpoints[1].live.clone()))
            }
            2 => {
                view.endpoints.pop();
            }
            _ => view.endpoints[1].enabled = false,
        });
        // Invoke the captured callback identity directly: simulate_click redraws
        // first and would correctly capture the replacement generation instead.
        view.update(cx, |view, cx| {
            view.click_toast("ssh:toast", generation, &inbox, 0, cx)
        });
        view.read_with(cx, |view, _| {
            assert_eq!(view.selected_endpoint, 0);
            assert!(view.pending_navigation.is_none());
            assert!(view.pending_toast.is_none());
        });
    }
}

#[gpui::test]
fn toast_queue_failure_retains_notice(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (mut endpoint, _server) = connected_endpoint("ssh:toast");
    let mut wire = crate::notifications::tests::notification("queue failure");
    wire.workspace_id = Some("w1".into());
    endpoint
        .toasts
        .receive([crate::notifications::Notice::new(wire, Instant::now())
            .with_snapshot(endpoint.live.snapshot.as_deref())
            .preview()]);
    view.update(cx, |view, cx| {
        view.endpoints.push(endpoint);
        view.selected_endpoint = 1;
        view.options = ConnectOptions::default();
        view.reset_selected(cx);
        // Keep the projected connected state to exercise enqueue failure itself.
        view.endpoints[1].connection.inbox = Arc::new(Mutex::new(view.live.clone()));
        view.endpoints[1]
            .connection
            .handle
            .as_ref()
            .unwrap()
            .disconnect();
        assert!(view.input_ready());
        view.tick_toasts(false, Instant::now());
        view.navigate_toast(0, cx);
        assert_eq!(view.endpoints[1].toasts.entries.len(), 1);
        assert!(view.local_error.is_some());
    });
}

#[gpui::test]
fn notification_command_rejects_ineligible_cards_without_selection_or_requests(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for case in 0..7 {
        let (mut endpoint, mut server) = connected_endpoint("ssh:toast");
        let mut wire = crate::notifications::tests::notification("ineligible");
        wire.workspace_id = (case != 0).then(|| "w1".into());
        let mut notice = crate::notifications::Notice::new(wire, Instant::now())
            .with_snapshot(endpoint.live.snapshot.as_deref())
            .preview();
        if case != 4 {
            notice.promote(Instant::now());
        }
        if case == 3 {
            notice.expires = Instant::now();
        }
        endpoint.toasts.receive([notice]);
        if case == 1 || case == 2 {
            let mut state = endpoint.connection.inbox.lock().unwrap();
            let snapshot = Arc::make_mut(state.snapshot.as_mut().unwrap());
            if case == 1 {
                snapshot.workspaces.clear();
            } else {
                snapshot.boot_id = "new-boot".into();
            }
        }
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.menu.reset();
                view.endpoints.truncate(1);
                view.endpoints.push(endpoint);
                view.selected_endpoint = 0;
                view.toasts_hidden = case == 5;
                if case == 6 {
                    view.open_keybinds(window, cx);
                }
                view.command(Command::OpenNotificationTarget, window, cx);
                assert_eq!(view.selected_endpoint, 0, "case {case}");
                assert!(view.pending_navigation.is_none());
                assert!(view.pending_toast.is_none());
                assert_eq!(view.endpoints[1].toasts.entries.len(), 1);
                view.endpoints[1]
                    .connection
                    .handle
                    .as_ref()
                    .unwrap()
                    .set_focus(&snapshot().boot_id, false)
                    .unwrap();
            })
        });
        // Ordered sentinel proves that no focus request preceded it.
        assert!(matches!(
            server.receive(),
            ClientMessage::ClientShellFocus { focused: false }
        ));
    }
}
