use super::*;

#[gpui::test]
fn newer_same_endpoint_navigation_cannot_replay_a_pending_toast(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (mut endpoint, mut server) = connected_endpoint("ssh:toast");
    let inbox = endpoint.connection.inbox.clone();
    let mut wire = crate::notifications::tests::notification("older intent");
    wire.workspace_id = Some("w1".into());
    wire.pane_id = Some("w1:p1".into());
    endpoint
        .toasts
        .receive([crate::notifications::Notice::new(wire, Instant::now())
            .with_snapshot(endpoint.live.snapshot.as_deref())
            .preview()]);
    view.update(cx, |view, cx| {
        view.endpoints[0].detached = true;
        view.endpoints.push(endpoint);
        view.selected_endpoint = 1;
        view.options = ConnectOptions::default();
        view.reset_selected(cx);
        view.tick_toasts(false, Instant::now());
        let held = inbox.lock().unwrap();
        view.click_toast("ssh:toast", view.endpoints[1].generation, &inbox, 0, cx);
        assert_eq!(view.pending_toast, Some(0));
        assert_eq!(
            view.pending_navigation,
            Some(NavigationTarget::Pane("w1:p1".into()))
        );
        drop(held);
        assert!(view.navigation_ready());
        view.navigate_endpoint("ssh:toast", NavigationTarget::Pane("new-pane"), cx);
        assert!(view.pending_toast.is_none());
        assert!(view.pending_navigation.is_none());
        assert!(!view.input_ready());
    });
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("missing newer navigation");
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], "pane.focus");
    assert_eq!(request["params"]["pane_id"], "new-pane");
    server.respond(&request);
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("missing newer navigation barrier");
    };
    let barrier: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(barrier["method"], Method::ClientShellSurfaceSet.as_str());
    let mut next = snapshot();
    next.revision += 1;
    let mut pane = next.panes[0].clone();
    pane.pane_id = "new-pane".into();
    next.panes[0].focused = false;
    next.panes.push(pane);
    next.focused_pane_id = Some("new-pane".into());
    write_message(&mut server.stream, &ServerMessage::ClientShellEndpointResponseChunk {
        boot_id: next.boot_id.clone(),
        request_id: barrier["id"].as_str().unwrap().into(),
        final_chunk: true,
        data: serde_json::to_vec(&serde_json::json!({"id": barrier["id"], "result": {
            "type": "client_shell_surface_set", "active": true, "projection_revision": next.revision
        }})).unwrap(),
    }, MAX_GRAPHICS_FRAME_SIZE).unwrap();
    wait_until(|| {
        inbox
            .lock()
            .unwrap()
            .activation
            .as_ref()
            .and_then(|a| a.revision)
            == Some(next.revision)
    });
    {
        let mut state = inbox.lock().unwrap();
        state.apply(ClientEvent::Snapshot(Arc::new(next.clone())));
        state.apply(ClientEvent::Surface(surface(&next)));
    }
    view.update(cx, |view, cx| {
        project_until(view, cx, "newer navigation completed", |view| {
            view.live
                .snapshot
                .as_ref()
                .is_some_and(|s| s.revision == next.revision)
        });
        view.poll_endpoints(cx);
        assert!(view.pending_navigation.is_none());
        assert!(view.input_ready());
        assert_eq!(
            view.live
                .snapshot
                .as_ref()
                .unwrap()
                .focused_pane_id
                .as_deref(),
            Some("new-pane")
        );
        // FIFO input proves no old pane.focus was queued after the completed barrier.
        view.send(
            ClientPaneInputEvent::TextCommit("new intent only".into()),
            cx,
        );
    });
    let ClientMessage::ClientShellPaneInput { pane_id, .. } = server.receive() else {
        panic!("old navigation replayed instead of input to the newer target");
    };
    assert_eq!(pane_id, "new-pane");
}

#[gpui::test]
fn toast_handoff_retains_busy_validation_and_revalidates_before_queueing(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for (deleted, busy_click, already_active) in [
        (false, false, false),
        (false, true, false),
        (true, false, false),
        (true, true, false),
        (false, true, true),
        (true, true, true),
    ] {
        let (mut endpoint, mut server) = connected_endpoint("ssh:toast");
        endpoint.initial_surface = already_active;
        let mut wire = crate::notifications::tests::notification("handoff");
        wire.workspace_id = Some("w1".into());
        endpoint
            .toasts
            .receive([crate::notifications::Notice::new(wire, Instant::now())
                .with_snapshot(endpoint.live.snapshot.as_deref())
                .preview()]);
        view.update(cx, |view, cx| {
            view.selected_endpoint = 0;
            view.endpoints.truncate(1);
            view.endpoints[0].detached = true;
            view.endpoints.push(endpoint);
            view.options = ConnectOptions::default();
            if already_active {
                view.selected_endpoint = 1;
                view.reset_selected(cx);
                assert!(view.input_ready());
            }
            let inbox = view.endpoints[1].connection.inbox.clone();
            view.tick_toasts(false, Instant::now());
            let held = busy_click.then(|| inbox.lock().unwrap());
            view.click_toast("ssh:toast", view.endpoints[1].generation, &inbox, 0, cx);
            drop(held);
            assert_eq!(view.pending_toast, Some(0));
            assert!(!view.input_ready());
            assert_eq!(view.endpoints[1].toasts.entries.len(), 1);
            // Complete the handoff with a coherent current projection.
            {
                let mut state = inbox.lock().unwrap();
                if deleted {
                    Arc::make_mut(state.snapshot.as_mut().unwrap())
                        .workspaces
                        .clear();
                }
                state.surface = Some(surface(state.snapshot.as_ref().unwrap()));
                state.activation = None;
                state.dirty = true;
                view.endpoints[1].initial_surface = true;
                // Project the completed handoff, then deterministically hold
                // the inbox across polling and attempted terminal input.
                view.endpoints[1].live = state.clone();
                view.live = state.clone();
                for _ in 0..2 {
                    view.poll_endpoints(cx);
                    assert!(view.navigation_ready());
                    assert!(!view.input_ready());
                    assert_eq!(view.pending_toast, Some(0));
                    assert_eq!(
                        view.pending_navigation,
                        Some(NavigationTarget::Workspace("w1".into()))
                    );
                    assert_eq!(view.endpoints[1].toasts.entries.len(), 1);
                    view.send(
                        ClientPaneInputEvent::TextCommit("must stay fenced".into()),
                        cx,
                    );
                }
            }
            project_until(view, cx, "toast handoff", |view| {
                view.pending_toast.is_none()
            });
            assert_eq!(view.endpoints[1].toasts.entries.len(), usize::from(deleted));
            assert!(view.pending_navigation.is_none());
            assert_eq!(view.input_ready(), deleted);
            if deleted {
                view.endpoints[1]
                    .connection
                    .handle
                    .as_ref()
                    .unwrap()
                    .set_focus(&snapshot().boot_id, false)
                    .unwrap();
            }
        });
        if !deleted {
            let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
                panic!("expected focus after handoff")
            };
            let request: serde_json::Value = serde_json::from_str(&request).unwrap();
            assert_eq!(request["method"], "workspace.focus");
        } else {
            assert!(matches!(
                server.receive(),
                ClientMessage::ClientShellFocus { focused: false }
            ));
        }
    }
}

#[gpui::test]
fn accepted_toast_survives_expiry_but_not_invalidation(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for invalidation in [
        "none",
        "dismiss",
        "replace",
        "boot",
        "membership",
        "generation",
        "overflow",
    ] {
        let (mut endpoint, mut server) = connected_endpoint("ssh:toast");
        endpoint.initial_surface = false;
        let mut wire = crate::notifications::tests::notification("accepted");
        wire.workspace_id = Some("w1".into());
        wire.pane_id = Some("w1:p1".into());
        endpoint.toasts.receive([
            crate::notifications::Notice::new(wire.clone(), Instant::now())
                .with_snapshot(endpoint.live.snapshot.as_deref())
                .preview(),
        ]);
        view.update(cx, |view, cx| {
            view.selected_endpoint = 0;
            view.endpoints.truncate(1);
            view.endpoints[0].detached = true;
            view.reset_selected(cx);
            view.endpoints.push(endpoint);
            view.tick_toasts(false, Instant::now());
            let inbox = view.endpoints[1].connection.inbox.clone();
            view.click_toast("ssh:toast", view.endpoints[1].generation, &inbox, 0, cx);
            assert_eq!(view.pending_toast, Some(0));
            assert!(!view.input_ready());
            let after_expiry =
                view.endpoints[1].toasts.entries[0].1.expires + Duration::from_secs(1);
            view.tick_toasts(false, after_expiry);
            assert_eq!(view.endpoints[1].toasts.entries.len(), 1);
            // An accepted intent also remains eligible between timer samples.
            view.endpoints[1].toasts.entries[0].1.expires = Instant::now();
            assert!(matches!(
                view.toast_target(1, 0),
                std::task::Poll::Ready(Some(_))
            ));
            match invalidation {
                "dismiss" => view.endpoints[1].toasts.dismiss(0),
                "replace" => {
                    // Revalidate against an undrained replacement, not just the UI queue.
                    inbox.lock().unwrap().apply(ClientEvent::Message(
                        ServerMessage::SemanticNotification(wire),
                    ));
                }
                "boot" => {
                    Arc::make_mut(inbox.lock().unwrap().snapshot.as_mut().unwrap()).boot_id =
                        "other".into()
                }
                "membership" => Arc::make_mut(inbox.lock().unwrap().snapshot.as_mut().unwrap())
                    .panes
                    .clear(),
                "generation" => view.endpoints[1].stop(),
                "overflow" => {
                    let mut state = inbox.lock().unwrap();
                    state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
                        wire,
                    )));
                    for _ in 0..crate::notifications::PENDING_LIMIT {
                        state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
                            crate::notifications::tests::notification("other"),
                        )));
                    }
                }
                _ => {}
            }
            if invalidation != "generation" {
                view.endpoints[1].initial_surface = true;
                view.live = inbox.lock().unwrap().clone();
                view.live.surface = Some(surface(view.live.snapshot.as_ref().unwrap()));
                view.live.activation = None;
                view.navigate_toast(0, cx);
                assert!(view.pending_toast.is_none());
                if invalidation == "none" {
                    assert!(view.endpoints[1].toasts.entries.is_empty());
                } else {
                    view.endpoints[1]
                        .connection
                        .handle
                        .as_ref()
                        .unwrap()
                        .set_focus(&snapshot().boot_id, false)
                        .unwrap();
                }
            } else {
                assert_eq!(view.toast_target(1, 0), std::task::Poll::Ready(None));
            }
        });
        if invalidation == "none" {
            let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
                panic!("missing accepted focus")
            };
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&request).unwrap()["method"],
                "pane.focus"
            );
        } else if invalidation != "generation" {
            assert!(
                matches!(
                    server.receive(),
                    ClientMessage::ClientShellFocus { focused: false }
                ),
                "{invalidation}"
            );
        }
    }
}

#[gpui::test]
fn toast_handoff_defers_a_contended_source_without_activating_destination(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (source, mut source_server) = connected_endpoint("ssh:source");
    let (mut target, mut target_server) = connected_endpoint("ssh:target");
    target.initial_surface = false;
    let source_inbox = source.connection.inbox.clone();
    let target_inbox = target.connection.inbox.clone();
    let target_handle = target.connection.handle.clone().unwrap();
    let mut wire = crate::notifications::tests::notification("target");
    wire.workspace_id = Some("w1".into());
    target
        .toasts
        .receive([crate::notifications::Notice::new(wire, Instant::now())
            .with_snapshot(target.live.snapshot.as_deref())
            .preview()]);
    let held = source_inbox.lock().unwrap();
    view.update(cx, |view, cx| {
        view.endpoints[0].detached = true;
        view.endpoints.extend([source, target]);
        view.selected_endpoint = 1;
        view.reset_selected(cx);
        view.tick_toasts(false, Instant::now());
        view.click_toast(
            "ssh:target",
            view.endpoints[2].generation,
            &target_inbox,
            0,
            cx,
        );
        assert_eq!(view.selected_endpoint, 2);
        assert_eq!(view.pending_toast, Some(0));
        for _ in 0..2 {
            view.poll_endpoints(cx);
            assert!(matches!(
                view.pending_releases[0].phase,
                ReleasePhase::Deferred(_)
            ));
            assert!(!view.endpoints[2].initial_surface);
            assert!(!view.input_ready());
        }
    });
    target_handle.set_focus(&snapshot().boot_id, false).unwrap();
    assert!(matches!(
        target_server.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    ));
    drop(held);
    view.update(cx, |view, cx| {
        project_until(view, cx, "source release queued", |view| {
            matches!(view.pending_releases[0].phase, ReleasePhase::Sent(_))
        })
    });
    assert!(matches!(
        source_server.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    ));
    let ClientMessage::ClientShellEndpointRequest { request, .. } = source_server.receive() else {
        panic!("missing source release")
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], Method::ClientShellSurfaceSet.as_str());
    assert_eq!(request["params"]["active"], false);
    target_handle.set_focus(&snapshot().boot_id, true).unwrap();
    assert!(matches!(
        target_server.receive(),
        ClientMessage::ClientShellFocus { focused: true }
    ));
    source_inbox.lock().unwrap().apply(ClientEvent::Response {
        request_id: request["id"].as_str().unwrap().into(),
        response: serde_json::json!({"result": {"type": "client_shell_surface_set", "active": false, "projection_revision": 7}}),
    });
    view.update(cx, |view, cx| {
        project_until(view, cx, "source release acknowledged", |view| {
            view.endpoints[2].initial_surface
        });
        assert!(view.pending_releases.is_empty());
        assert!(view.endpoints[2].initial_surface);
        assert!(!view.input_ready());
    });
    assert!(matches!(
        target_server.receive(),
        ClientMessage::ClientShellResize { .. }
    ));
    let ClientMessage::ClientShellEndpointRequest { request, .. } = target_server.receive() else {
        panic!("missing destination activation")
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], Method::ClientShellSurfaceSet.as_str());
    assert_eq!(request["params"]["active"], true);
}
