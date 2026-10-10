use super::*;

/// Herdr's `last_pane` returns to the pane focused before this one,
/// across tabs and workspaces, but never across a daemon reboot.
#[test]
fn previous_pane_follows_focus_within_one_boot() {
    let focus = |pane: Option<&str>, boot: &str| {
        let mut next = (*snapshot()).clone();
        next.focused_pane_id = pane.map(str::to_owned);
        next.boot_id = boot.into();
        ClientEvent::Snapshot(Arc::new(next))
    };
    let mut state = LiveState::default();
    state.apply(focus(Some("a"), "boot"));
    assert_eq!(state.previous_pane, None);
    state.apply(focus(Some("a"), "boot"));
    assert_eq!(state.previous_pane, None);
    state.apply(focus(Some("b"), "boot"));
    assert_eq!(state.previous_pane.as_deref(), Some("a"));
    // A snapshot that changes something else keeps the last pane.
    state.apply(focus(Some("b"), "boot"));
    assert_eq!(state.previous_pane.as_deref(), Some("a"));
    // Losing focus remembers the pane that had it.
    state.apply(focus(None, "boot"));
    assert_eq!(state.previous_pane.as_deref(), Some("b"));
    state.apply(focus(Some("c"), "reboot"));
    assert_eq!(state.previous_pane, None);
    state.apply(focus(Some("d"), "reboot"));
    state.apply(ClientEvent::Disconnected {
        reason: "gone".into(),
        ssh: None,
    });
    state.apply(focus(Some("e"), "reboot"));
    assert_eq!(state.previous_pane, None);
}

fn activating(snapshot: &ClientShellSnapshot) -> SurfaceActivation {
    SurfaceActivation {
        request: "activate-1".into(),
        boot: snapshot.boot_id.clone(),
        revision: None,
        failed: false,
        focus: None,
        active: true,
    }
}

#[test]
fn completed_navigation_retires_focus_in_inbox_before_later_focus_changes() {
    for kind in ["pane", "tab", "workspace"] {
        for ack_first in [false, true] {
            let snapshot = snapshot();
            let id = match kind {
                "workspace" => snapshot.focused_workspace_id.clone().unwrap(),
                "tab" => snapshot.focused_tab_id.clone().unwrap(),
                _ => snapshot.focused_pane_id.clone().unwrap(),
            };
            let mut state = LiveState::default();
            state.apply(ClientEvent::Snapshot(snapshot.clone()));
            state.activation = Some(SurfaceActivation {
                focus: Some(match kind {
                    "workspace" => crate::NavigationTarget::Workspace(id),
                    "tab" => crate::NavigationTarget::Tab(id),
                    _ => crate::NavigationTarget::Pane(id),
                }),
                ..activating(&snapshot)
            });
            let ack = ClientEvent::Response {
                request_id: "activate-1".into(),
                response: serde_json::json!({"result": {
                    "type": "client_shell_surface_set", "active": true,
                    "projection_revision": snapshot.revision
                }}),
            };
            let frame = ClientEvent::Surface(surface(&snapshot));
            let events = if ack_first {
                [ack, frame]
            } else {
                [frame, ack]
            };
            for (index, event) in events.into_iter().enumerate() {
                state.apply(event);
                assert_eq!(state.surface_ready(), index == 1);
                assert_eq!(
                    state.activation.as_ref().unwrap().focus.is_none(),
                    index == 1
                );
            }
            // No UI poll between completion and the split/tab/workspace's
            // next projection: the authoritative reducer must already settle.
            let mut next = snapshot.clone();
            let next_snapshot = Arc::make_mut(&mut next);
            next_snapshot.revision += 1;
            next_snapshot.focused_pane_id = Some("split-pane".into());
            next_snapshot.focused_tab_id = Some("created-tab".into());
            next_snapshot.focused_workspace_id = Some("created-workspace".into());
            state.apply(ClientEvent::Snapshot(next.clone()));
            assert!(!state.surface_ready());
            state.apply(ClientEvent::Surface(surface(&next)));
            assert!(state.surface_ready());
            let settled = state.activation.as_ref().unwrap();
            assert_eq!(settled.revision, Some(snapshot.revision));
            assert_eq!(settled.boot, snapshot.boot_id);
            assert!(settled.active && !settled.failed);
        }
    }
}

#[test]
fn activation_requires_matching_ack_coherent_revision_and_focus() {
    let snapshot = snapshot();
    let mut state = LiveState::default();
    state.apply(ClientEvent::Snapshot(snapshot.clone()));
    state.activation = Some(activating(&snapshot));
    state.apply(ClientEvent::Surface(surface(&snapshot)));
    assert!(!state.surface_ready());
    let response = serde_json::json!({"result": {
        "type": "client_shell_surface_set", "active": true, "projection_revision": snapshot.revision
    }});
    state.apply(ClientEvent::Response {
        request_id: "stale".into(),
        response: response.clone(),
    });
    assert!(!state.surface_ready());
    state.apply(ClientEvent::Response {
        request_id: "activate-1".into(),
        response,
    });
    assert!(state.surface_ready());
    state.activation.as_mut().unwrap().focus =
        Some(crate::NavigationTarget::Pane("wrong-pane".into()));
    assert!(!state.surface_ready());
    state.activation.as_mut().unwrap().focus = None;
    state.activation.as_mut().unwrap().revision = Some(snapshot.revision + 1);
    assert!(!state.surface_ready());
    let mut reboot = snapshot.clone();
    Arc::make_mut(&mut reboot).boot_id = "reboot".into();
    state.apply(ClientEvent::Snapshot(reboot.clone()));
    state.apply(ClientEvent::Surface(surface(&reboot)));
    assert!(state.activation.as_ref().unwrap().failed);
    assert!(!state.surface_ready());
}

#[test]
fn rejected_malformed_and_wrong_direction_acks_never_enable_input() {
    let snapshot = snapshot();
    for response in [
        serde_json::json!({"error": {"message": "unsupported"}}),
        serde_json::json!({"result": {"type": "other", "active": true, "projection_revision": 0}}),
        serde_json::json!({"result": {"type": "client_shell_surface_set", "active": false, "projection_revision": 0}}),
    ] {
        let mut state = LiveState::default();
        state.apply(ClientEvent::Snapshot(snapshot.clone()));
        state.apply(ClientEvent::Surface(surface(&snapshot)));
        state.activation = Some(activating(&snapshot));
        state.apply(ClientEvent::Response {
            request_id: "activate-1".into(),
            response,
        });
        assert!(state.activation.as_ref().unwrap().failed);
        assert!(!state.surface_ready());
    }
    let mut state = LiveState {
        activation: Some(activating(&snapshot)),
        ..Default::default()
    };
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("activate-1".into()),
        reason: herdr_client::Error::UnsupportedMethod,
    });
    assert!(state.activation.as_ref().unwrap().failed);
}
