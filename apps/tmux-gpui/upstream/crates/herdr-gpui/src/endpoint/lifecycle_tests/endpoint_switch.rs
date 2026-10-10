use super::*;

#[gpui::test]
fn saved_selection_waits_for_snapshot_without_overwriting_preference(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (mut remote, _server) = connected_endpoint("ssh:saved");
    let ready = remote.live.clone();
    remote.live.snapshot = None;
    remote.initial_surface = false;
    view.update(cx, |view, cx| {
        view.catalog.desired = Some("ssh:saved".into());
        view.catalog.initialized = true;
        view.catalog.restore_pending = true;
        // The catalog and then its connection can arrive long after startup.
        view.restore_selection(cx);
        assert!(view.catalog.restore_pending);
        view.endpoints.push(remote);
        for _ in 0..10 {
            view.restore_selection(cx);
            assert_eq!(view.selected_endpoint, 0);
            assert!(view.activation_deadline.is_none());
        }
        view.endpoints[1].live = ready;
        view.restore_selection(cx);
        assert_eq!(view.selected_endpoint, 1);
        assert!(!view.catalog.restore_pending);
        assert!(view.catalog.queued_write.is_none());
        // Automatic fallback is not a user choice and must not cause a loop.
        view.switch_endpoint(LOCAL, cx);
        view.restore_selection(cx);
        assert_eq!(view.selected_endpoint, 0);
        assert_eq!(view.catalog.desired.as_deref(), Some("ssh:saved"));
        assert!(view.catalog.queued_write.is_none());
        // An explicit Local click cancels even a not-yet-ready restore.
        view.catalog.restore_pending = true;
        view.select_endpoint(LOCAL, cx);
        view.restore_selection(cx);
        assert_eq!(view.catalog.desired, None);
        assert_eq!(view.selected_endpoint, 0);
    });
}

/// Another host changing redraws the window but leaves the selected host's
/// window state alone: a split request the window is still waiting on must
/// not vanish because a different endpoint had news, and the selected host's
/// own news still arrives.
#[gpui::test]
fn another_endpoint_changing_keeps_the_selected_window_state(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (selected, _server) = connected_endpoint("ssh:selected");
    let (other, _other_server) = connected_endpoint("ssh:other");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            prepare_mouse(view, selected, cx);
            view.endpoints.push(other);
            view.poll_endpoints(cx);
            view.live.drag_request = Some("gpui-pending".into());

            view.endpoints[2].connection.inbox.lock().unwrap().dirty = true;
            view.poll_endpoints(cx);
            assert_eq!(view.live.drag_request.as_deref(), Some("gpui-pending"));

            view.endpoints[1].connection.inbox.lock().unwrap().error = Some("news".into());
            view.endpoints[1].connection.inbox.lock().unwrap().dirty = true;
            view.poll_endpoints(cx);
            assert_eq!(view.live.error.as_deref(), Some("news"));
        });
    });
}

#[gpui::test]
fn deferred_release_is_generation_fenced_and_local_can_escape(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for change in ["retire", "boot", "local"] {
        let (source, _source_server) = connected_endpoint("ssh:source");
        let (mut target, _target_server) = connected_endpoint("ssh:target");
        target.initial_surface = false;
        let inbox = source.connection.inbox.clone();
        let drained = source.connection.drained.clone();
        let handle = source.connection.handle.clone().unwrap();
        let mut held = inbox.lock().unwrap();
        view.update(cx, |view, cx| {
            view.pending_releases.clear();
            view.endpoints.truncate(1);
            view.endpoints[0].detached = true;
            view.endpoints.extend([source, target]);
            view.selected_endpoint = 1;
            view.reset_selected(cx);
            assert!(view.select_endpoint("ssh:target", cx));
            assert!(matches!(
                view.pending_releases[0].phase,
                ReleasePhase::Deferred(_)
            ));
            match change {
                "retire" => {
                    view.endpoints[1].stop();
                    view.endpoints[1].detached = true;
                    assert!(!Arc::ptr_eq(&inbox, &view.endpoints[1].connection.inbox));
                    assert!(handle.is_disconnected());
                }
                "boot" => {
                    Arc::make_mut(held.snapshot.as_mut().unwrap()).boot_id = "replacement".into()
                }
                _ => {
                    assert!(view.select_endpoint(LOCAL, cx));
                    assert!(view.pending_releases.is_empty());
                    assert!(handle.is_disconnected());
                }
            }
            assert!(!view.endpoints[2].initial_surface);
        });
        drop(held);
        view.update(cx, |view, cx| {
            if change == "boot" {
                project_until(view, cx, "stale source retired", |_| {
                    handle.is_disconnected()
                });
                view.endpoints[1].detached = true;
            }
        });
        wait_until(|| drained.load(Ordering::Acquire));
        if change != "local" {
            view.update(cx, |view, cx| {
                project_until(view, cx, "retired source drained", |view| {
                    view.endpoints[2].initial_surface
                });
                assert!(view.pending_releases.is_empty());
            });
        }
    }
}

#[gpui::test]
fn retiring_release_source_unblocks_destination_without_waiting_for_timeout(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for change in ["remove", "disable", "retarget", "disconnect"] {
        let (mut source, mut source_server) = connected_endpoint("ssh:source");
        let (mut target, mut target_server) = connected_endpoint("ssh:target");
        let profile = |id: &str| SavedHost {
            id: id.into(),
            label: id.into(),
            target: id.into(),
            session: "default".into(),
            enabled: true,
        };
        // These already-connected test transports stand in for SSH profiles;
        // catalog reconciliation must not try opening actual SSH connections.
        source.connection.target = ConnectTarget::Ssh {
            target: "source".into(),
            session: "default".into(),
        };
        target.connection.target = ConnectTarget::Ssh {
            target: "target".into(),
            session: "default".into(),
        };
        target.initial_surface = false;
        let drained = source.connection.drained.clone();
        let source_handle = source.connection.handle.clone().unwrap();
        view.update(cx, |view, cx| {
            view.endpoints.truncate(1);
            view.endpoints[0].detached = true;
            view.endpoints.extend([source, target]);
            view.selected_endpoint = 1;
            view.reset_selected(cx);
            view.select_endpoint("ssh:target", cx);
            assert_eq!(view.pending_releases.len(), 1);
            view.poll_endpoints(cx);
            assert!(!view.endpoints[2].initial_surface);
        });
        // The release went onto the old transport but is never acknowledged.
        assert!(matches!(
            source_server.receive(),
            ClientMessage::ClientShellFocus { focused: false }
        ));
        assert!(matches!(
            source_server.receive(),
            ClientMessage::ClientShellEndpointRequest { .. }
        ));
        view.update(cx, |view, cx| {
            let mut source_profile = profile("source");
            match change {
                "remove" => view.reconcile_catalog(vec![profile("target")], Vec::new(), cx),
                "disable" => {
                    source_profile.enabled = false;
                    view.reconcile_catalog(vec![source_profile, profile("target")], Vec::new(), cx);
                }
                "retarget" => {
                    source_profile.session = "new-session".into();
                    view.reconcile_catalog(vec![source_profile, profile("target")], Vec::new(), cx);
                }
                _ => {}
            }
            for endpoint in &mut view.endpoints {
                endpoint.retry_at = Instant::now() + Duration::from_secs(120);
            }
        });
        if change == "disconnect" {
            source_server
                .stream
                .shutdown(std::net::Shutdown::Both)
                .unwrap();
        }
        wait_until(|| drained.load(Ordering::Acquire));
        assert!(source_handle.is_disconnected());
        view.update(cx, |view, cx| {
            assert!(!view.pending_releases.is_empty());
            view.poll_endpoints(cx);
            assert!(view.pending_releases.is_empty(), "{change}");
            assert_eq!(view.endpoints[view.selected_endpoint].id, "ssh:target");
            assert!(view.endpoints[view.selected_endpoint].initial_surface);
            assert!(view.activation_deadline.unwrap() > Instant::now());
        });
        assert!(matches!(
            target_server.receive(),
            ClientMessage::ClientShellResize { .. }
        ));
        let ClientMessage::ClientShellEndpointRequest { request, .. } = target_server.receive()
        else {
            panic!("destination not activated");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&request).unwrap()["method"],
            Method::ClientShellSurfaceSet.as_str()
        );
    }
}
