#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::{ClientEvent, SavedHost};

#[test]
fn saved_profile_ids_are_the_catalog_ids_behind_ssh_endpoints() {
    let id = "0123456789abcdef0123456789abcdef";
    assert_eq!(saved_profile_id(&format!("ssh:{id}")), Some(id));
    for endpoint in [id, LOCAL, "ssh:", "ssh:fixture", "ssh:../x"] {
        assert_eq!(saved_profile_id(endpoint), None, "{endpoint}");
    }
}

pub(super) fn host(id: &str, enabled: bool) -> SavedHost {
    SavedHost {
        id: id.into(),
        label: id.into(),
        target: format!("user@{id}"),
        session: "default".into(),
        enabled,
    }
}

#[test]
fn notifications_stay_endpoint_owned_and_expire_without_new_updates() {
    use crate::notifications::tests::notification;
    use herdr_client::protocol::ServerMessage;
    let mut local = Endpoint::new(LOCAL.into(), "Local".into(), ConnectTarget::Local, true);
    let mut remote = Endpoint::new(
        "ssh:test".into(),
        "Remote".into(),
        ConnectTarget::Local,
        true,
    );
    for endpoint in [&mut local, &mut remote] {
        let mut state = endpoint.connection.inbox.lock().unwrap();
        state.apply(ClientEvent::Snapshot(Arc::new(
            crate::sidebar::layout_tests::snapshot(1),
        )));
        state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            notification(&endpoint.label),
        )));
        state.apply(ClientEvent::Snapshot(Arc::new(
            crate::sidebar::layout_tests::snapshot(2),
        )));
    }
    let now = Instant::now();
    assert_eq!(local.poll(now), Redraw::Window);
    assert_eq!(remote.poll(now), Redraw::Window);
    assert!(local.live.notifications.is_empty());
    assert!(remote.live.notifications.is_empty());
    assert_eq!(local.toasts.entries[0].1.title, "Local");
    assert_eq!(remote.toasts.entries[0].1.title, "Remote");
    assert_eq!(remote.poll(now), Redraw::None);
    local.stop();
    assert!(local.toasts.entries.is_empty());
    assert_eq!(remote.toasts.entries.len(), 1);
    let mut endpoints = [local, remote];
    let config = crate::config::NotificationConfig {
        enabled: true,
        delay_seconds: 0,
        ..Default::default()
    };
    assert!(crate::notifications::tick(
        &mut endpoints,
        0,
        config,
        false,
        true,
        None,
        now
    ));
    let deadline = endpoints[1].toasts.entries[0].1.expires;
    assert!(crate::notifications::tick(
        &mut endpoints,
        0,
        config,
        false,
        true,
        None,
        deadline
    ));
    assert!(endpoints[1].toasts.entries.is_empty());
}

/// A pane app's OSC 52 copy reaches the pasteboard and reports the same
/// copy a local selection does, unless the toast is configured off.
#[gpui::test]
fn daemon_clipboard_writes_reach_the_pasteboard_and_report(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        assert!(view.apply_clipboard_writes(vec!["hello".into()], cx));
        assert!(
            view.flash.is_some(),
            "the copy is reported like a selection"
        );
    });
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("hello".into())
    );
    view.update(cx, |view, cx| {
        view.config.clipboard_toast.enabled = false;
        view.flash = None;
        assert!(view.apply_clipboard_writes(vec!["quiet".into()], cx));
        assert!(view.flash.is_none(), "a disabled toast stays silent");
        assert!(!view.apply_clipboard_writes(Vec::new(), cx));
    });
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text())),
        Some("quiet".into())
    );
}

#[test]
fn lost_ingress_retires_predecessors_even_when_replacement_was_evicted() {
    use crate::notifications::{Notice, PENDING_LIMIT, tests::notification};
    use herdr_client::protocol::{SemanticNotificationKind, ServerMessage};
    let mut endpoint = Endpoint::new(LOCAL.into(), "Local".into(), ConnectTarget::Local, true);
    let mut wire = notification("old attention");
    wire.pane_id = Some("p".into());
    let mut old = Notice::new(wire.clone(), Instant::now()).preview();
    old.promote(Instant::now());
    endpoint.toasts.receive([old]);
    let inbox = endpoint.connection.inbox.clone();
    {
        let mut state = inbox.lock().unwrap();
        state.status = ConnectionStatus::Connected;
        wire.kind = SemanticNotificationKind::Finished;
        state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            wire,
        )));
        for index in 0..PENDING_LIMIT {
            state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
                notification(&index.to_string()),
            )));
        }
        assert!(state.notifications_lost);
        assert_eq!(state.notifications.len(), PENDING_LIMIT);
        assert!(state.notifications.iter().all(|n| n.pane_id.is_none()));
    }
    assert_eq!(endpoint.poll(Instant::now()), Redraw::Window);
    assert_eq!(endpoint.toasts.entries.len(), PENDING_LIMIT);
    assert!(
        endpoint
            .toasts
            .entries
            .iter()
            .all(|(_, n)| n.title != "old attention")
    );
    // The loss marker moves with the batch exactly once, not every snapshot.
    inbox.lock().unwrap().dirty = true;
    assert_eq!(
        endpoint.poll(Instant::now()),
        Redraw::Terminal,
        "an update that changes nothing the chrome reads spares the sidebar"
    );
    assert!(!endpoint.live.notifications_lost);
    assert_eq!(endpoint.toasts.entries.len(), PENDING_LIMIT);
}

#[test]
fn notifications_clear_on_boot_change_and_disconnect() {
    use crate::notifications::tests::notification;
    use herdr_client::protocol::ServerMessage;
    let mut endpoint = Endpoint::new(LOCAL.into(), "Local".into(), ConnectTarget::Local, true);
    let mut snapshot = crate::sidebar::layout_tests::snapshot(1);
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Snapshot(Arc::new(snapshot.clone())));
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            notification("old"),
        )));
    endpoint.poll(Instant::now());
    assert_eq!(endpoint.toasts.entries.len(), 1);
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            notification("pending old"),
        )));
    snapshot.boot_id = "replacement-boot".into();
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Snapshot(Arc::new(snapshot)));
    endpoint.poll(Instant::now());
    assert!(endpoint.toasts.entries.is_empty());
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            notification("new"),
        )));
    endpoint.poll(Instant::now());
    assert_eq!(endpoint.toasts.entries.len(), 1);
    endpoint
        .connection
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Disconnected {
            reason: "test".into(),
            ssh: None,
        });
    endpoint.poll(Instant::now());
    assert!(endpoint.toasts.entries.is_empty());
}

#[test]
fn retired_generation_cannot_publish_into_replacement() {
    let mut endpoint = Endpoint::new(LOCAL.into(), "Local".into(), ConnectTarget::Local, true);
    let old = endpoint.connection.inbox.clone();
    let generation = endpoint.generation;
    endpoint.stop();
    assert!(endpoint.generation > generation);
    old.lock().unwrap().apply(ClientEvent::Snapshot(Arc::new(
        crate::sidebar::layout_tests::snapshot(1),
    )));
    endpoint.poll(Instant::now());
    assert!(endpoint.live.snapshot.is_none());
    assert!(!Arc::ptr_eq(&old, &endpoint.connection.inbox));
}

#[test]
fn release_waits_for_its_own_successful_inactive_acknowledgement() {
    let inbox = Arc::new(Mutex::new(LiveState::default()));
    inbox.lock().unwrap().activation = Some(crate::state::SurfaceActivation {
        request: "off".into(),
        boot: "boot".into(),
        revision: None,
        failed: false,
        focus: None,
        active: false,
    });
    let mut release = Release {
        inbox: inbox.clone(),
        drained: Arc::new(AtomicBool::new(false)),
        phase: ReleasePhase::Sent("off".into()),
        boot: "boot".into(),
    };
    assert!(!release.resolved());
    let response = serde_json::json!({"result": {
        "type": "client_shell_surface_set", "active": false, "projection_revision": 7
    }});
    inbox.lock().unwrap().apply(ClientEvent::Response {
        request_id: "old".into(),
        response: response.clone(),
    });
    assert!(!release.resolved());
    inbox.lock().unwrap().apply(ClientEvent::Response {
        request_id: "off".into(),
        response,
    });
    assert!(release.resolved());
    inbox.lock().unwrap().activation.as_mut().unwrap().failed = true;
    assert!(!release.resolved());
    inbox.lock().unwrap().activation = None;
    assert!(
        !release.resolved(),
        "discarding the acknowledgement is not retirement"
    );
    release.drained.store(true, Ordering::Release);
    assert!(
        release.resolved(),
        "confirmed transport termination releases ownership"
    );
}

#[gpui::test]
fn catalog_preserves_order_labels_and_scoped_collapse_but_retires_changed_targets(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.reconcile_catalog(vec![host("b", true), host("a", false)], Vec::new(), cx);
        assert_eq!(
            view.endpoints
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            [LOCAL, "ssh:b", "ssh:a"]
        );
        assert_eq!(view.endpoints[2].status(), "disabled");
        assert!(!view.select_endpoint("ssh:a", cx));
        view.endpoints[1]
            .collapsed_repos
            .insert("/same/repo".into());
        view.endpoints[1].collapsed = true;
        let inbox = view.endpoints[1].connection.inbox.clone();
        let mut renamed = host("b", true);
        renamed.label = "renamed".into();
        view.reconcile_catalog(vec![renamed.clone(), host("a", true)], Vec::new(), cx);
        assert!(Arc::ptr_eq(&inbox, &view.endpoints[1].connection.inbox));
        assert_eq!(view.endpoints[1].label, "renamed");
        assert!(view.endpoints[1].collapsed);
        assert!(view.endpoints[2].collapsed_repos.is_empty());
        assert!(view.select_endpoint("ssh:b", cx));
        let epoch = view.selection_epoch;
        renamed.session = "changed".into();
        view.reconcile_catalog(vec![host("a", true), renamed], Vec::new(), cx);
        assert_eq!(view.selected_endpoint, 0);
        assert!(view.selection_epoch > epoch);
        assert!(!Arc::ptr_eq(&inbox, &view.endpoints[2].connection.inbox));
        view.select_endpoint("ssh:a", cx);
        view.reconcile_catalog(vec![], Vec::new(), cx);
        assert_eq!(view.selected_endpoint, 0);
        assert_eq!(view.endpoints.len(), 1);
    });
}

/// The sessions list retargets a device to another of its sessions without
/// touching the catalog, which still names the session the device was saved
/// with. Reconciliation must not read that pick as a change of device and drag
/// the window back to the session it was previously on.
#[gpui::test]
fn a_session_picked_from_the_device_list_survives_catalog_reconciliation(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.reconcile_catalog(vec![host("b", true)], Vec::new(), cx);
        assert!(view.select_endpoint("ssh:b", cx));
        view.select_device_session("ssh:b", "other", cx);
        assert!(matches!(
            &view.endpoints[1].connection.target,
            ConnectTarget::Ssh { session, .. } if session == "other"
        ));
        view.reconcile_catalog(vec![host("b", true)], Vec::new(), cx);
        assert_eq!(view.selected_endpoint, 1);
        assert!(matches!(
            &view.endpoints[1].connection.target,
            ConnectTarget::Ssh { session, .. } if session == "other"
        ));
    });
}

#[gpui::test]
fn device_filter_follows_navigation_and_catalog_retirement(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.reconcile_catalog(vec![host("a", true), host("b", true)], Vec::new(), cx);
        assert!(view.select_endpoint("ssh:a", cx));
        assert!(
            view.device_filter.is_none(),
            "All Devices stays an aggregate"
        );
        view.device_filter = Some("ssh:a".into());
        assert!(view.select_endpoint("ssh:b", cx));
        assert_eq!(view.device_filter.as_deref(), Some("ssh:b"));
        let mut renamed = host("b", true);
        renamed.label = "Renamed device".into();
        view.reconcile_catalog(vec![renamed], Vec::new(), cx);
        assert_eq!(view.device_filter.as_deref(), Some("ssh:b"));
        view.reconcile_catalog(vec![host("b", false)], Vec::new(), cx);
        assert_eq!(view.device_filter.as_deref(), Some(LOCAL));
        assert!(!view.select_endpoint("ssh:b", cx));
        view.reconcile_catalog(vec![host("b", true)], Vec::new(), cx);
        assert!(view.select_endpoint("ssh:b", cx));
        view.reconcile_catalog(vec![], Vec::new(), cx);
        assert_eq!(view.device_filter.as_deref(), Some(LOCAL));
    });
}

#[gpui::test]
fn switching_away_retires_an_active_handshake_without_a_boot_id(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.reconcile_catalog(vec![host("remote", true)], Vec::new(), cx);
        view.endpoints[0].initial_surface = true;
        let inbox = view.endpoints[0].connection.inbox.clone();
        assert!(view.select_endpoint("ssh:remote", cx));
        assert!(!view.endpoints[0].initial_surface);
        assert!(!Arc::ptr_eq(&inbox, &view.endpoints[0].connection.inbox));
        assert!(view.pending_releases.is_empty());
    });
}

#[gpui::test]
fn timeout_and_return_to_local_do_not_wait_for_remote_release(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.active = true;
        let painted = view.endpoints[view.selected_endpoint]
            .connection
            .inbox
            .clone();
        let epoch = view.selection_epoch;
        let generation = view.endpoints[0].generation;
        // Selection epoch, connection generation and inbox identity together
        // decide whether deferred work still belongs to the current endpoint.
        let current = |view: &HerdrWindow| {
            view.selection_epoch == epoch
                && view.endpoints[view.selected_endpoint].generation == generation
                && Arc::ptr_eq(
                    &view.endpoints[view.selected_endpoint].connection.inbox,
                    &painted,
                )
        };
        assert!(current(view));
        view.reconcile_catalog(vec![host("remote", true)], Vec::new(), cx);
        for endpoint in &mut view.endpoints {
            endpoint.detached = true;
        }
        view.select_endpoint("ssh:remote", cx);
        assert!(!current(view));
        view.pending_releases.push(Release {
            inbox: view.endpoints[view.selected_endpoint]
                .connection
                .inbox
                .clone(),
            drained: Arc::new(AtomicBool::new(false)),
            phase: ReleasePhase::Sent("never-acked".into()),
            boot: "boot".into(),
        });
        // The activation budget runs only once there is a snapshot to activate.
        {
            let mut state = view.endpoints[view.selected_endpoint]
                .connection
                .inbox
                .lock()
                .unwrap();
            state.snapshot = Some(Arc::new(crate::sidebar::layout_tests::snapshot(1)));
            state.dirty = true;
        }
        view.activation_deadline = Some(Instant::now());
        view.poll_endpoints(cx);
        assert_eq!(view.selected_endpoint, 0);
        assert!(!current(view));
        assert!(view.pending_releases.is_empty());
        assert!(view.local_error.as_ref().unwrap().contains("timed out"));
        view.select_endpoint("ssh:remote", cx);
        let remote = view.endpoints[view.selected_endpoint]
            .connection
            .inbox
            .clone();
        view.select_endpoint(LOCAL, cx);
        assert!(!Arc::ptr_eq(
            &remote,
            &view.endpoints[view.selected_endpoint].connection.inbox
        ));
        assert!(view.pending_navigation.is_none());
    });
}

mod version_mismatch;
