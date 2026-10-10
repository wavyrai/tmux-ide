use super::*;

#[test]
fn snapshot_change_invalidates_cells_until_matching_surface() {
    let mut state = LiveState::default();
    let mut snapshot = snapshot();
    let old = surface(&snapshot);
    state.apply(ClientEvent::Snapshot(snapshot.clone()));
    state.apply(ClientEvent::Surface(old.clone()));
    assert!(state.surface.is_some());
    Arc::make_mut(&mut snapshot).revision += 1;
    state.apply(ClientEvent::Snapshot(snapshot.clone()));
    assert!(state.surface.is_none());
    state.apply(ClientEvent::Surface(old));
    assert!(state.surface.is_none());
    state.apply(ClientEvent::Surface(surface(&snapshot)));
    assert!(state.surface.is_some());
}

#[test]
fn surface_before_snapshot_is_not_retained_or_replayed() {
    let mut state = LiveState::default();
    let snapshot = snapshot();
    let frame = surface(&snapshot);
    state.apply(ClientEvent::Surface(frame.clone()));
    assert!(state.surface.is_none());
    state.apply(ClientEvent::Snapshot(snapshot));
    assert!(state.surface.is_none());
    state.apply(ClientEvent::Surface(frame.clone()));
    assert!(Arc::ptr_eq(state.surface.as_ref().unwrap(), &frame));

    state.apply(ClientEvent::Disconnected {
        reason: "closed".into(),
        ssh: None,
    });
    state.apply(ClientEvent::Surface(frame));
    assert!(state.snapshot.is_none());
    assert!(state.surface.is_none());
    assert_eq!(state.status, ConnectionStatus::Disconnected);
    assert_eq!(state.error.as_deref(), Some("closed"));
}

#[test]
fn different_boot_and_disconnect_cannot_retain_old_cells() {
    let mut state = LiveState::default();
    let snapshot = snapshot();
    let mut wrong_boot = surface(&snapshot);
    Arc::make_mut(&mut wrong_boot).boot_id = "old-boot".into();
    state.apply(ClientEvent::Snapshot(snapshot.clone()));
    state.apply(ClientEvent::Surface(wrong_boot));
    assert!(state.surface.is_none());
    state.apply(ClientEvent::Surface(surface(&snapshot)));
    state.apply(ClientEvent::Disconnected {
        reason: "closed".into(),
        ssh: None,
    });
    assert!(state.snapshot.is_none() && state.surface.is_none());
    assert!(!state.status.is_connected());
    assert_eq!(state.error.as_deref(), Some("closed"));
}

#[test]
fn only_a_new_surface_spares_the_chrome() {
    let snapshot = snapshot();
    let mut old = LiveState::default();
    old.apply(ClientEvent::Snapshot(snapshot.clone()));
    old.apply(ClientEvent::Surface(surface(&snapshot)));
    // The mailbox hands the window clones: shared snapshot, new surface.
    let mut next = old.clone();
    next.apply(ClientEvent::Surface(Arc::new(PaneSurfaceFrame {
        surface_revision: 2,
        ..(*surface(&snapshot)).clone()
    })));
    assert!(old.only_surface_changed(&next));
    assert!(old.only_surface_changed(&old.clone()));

    type Change = (&'static str, fn(&mut LiveState));
    let changes: [Change; 10] = [
        ("snapshot", |s| {
            s.snapshot = s.snapshot.as_deref().cloned().map(Arc::new);
        }),
        ("status", |s| s.status = ConnectionStatus::Disconnected),
        ("error", |s| s.error = Some("lost".into())),
        ("notification lost", |s| s.notifications_lost = true),
        ("sound", |s| s.reload_sound = true),
        ("clipboard write", |s| {
            s.clipboard_writes.push_back("x".into())
        }),
        ("dialog answer", |s| {
            s.dialog_response = Some(("remove".into(), Some(Ok(serde_json::Value::Null))));
        }),
        ("rename answer", |s| {
            s.pane_rename = Some(RenameResult {
                request: "rename".into(),
                result: Some(Ok(())),
            });
        }),
        ("drag answer", |s| s.drag_request = Some("scroll".into())),
        ("outer focus", |s| s.outer_focused = Some(true)),
    ];
    for (what, change) in changes {
        let mut changed = next.clone();
        change(&mut changed);
        assert!(!old.only_surface_changed(&changed), "{what}");
    }
}

#[test]
fn surface_images_follow_the_connection_and_file_paths_stay_ignored() {
    use herdr_client::{
        SurfaceImages,
        protocol::{
            SurfaceGraphicsAsset, SurfaceGraphicsAssetKey, SurfaceGraphicsFormat,
            SurfaceGraphicsSource, SurfaceGraphicsTarget,
        },
    };
    let key = SurfaceGraphicsAssetKey {
        source: SurfaceGraphicsSource::Terminal {
            target: SurfaceGraphicsTarget::Pane {
                pane_id: "p1".into(),
            },
            image_id: 1,
        },
        image_width: 1,
        image_height: 1,
        format: SurfaceGraphicsFormat::Rgba,
        data_len: 4,
        data_fingerprint: 1,
    };
    let images: SurfaceImages = [SurfaceGraphicsAsset {
        key: key.clone(),
        data: vec![0; 4],
    }]
    .into_iter()
    .collect();
    let mut state = LiveState::default();
    state.apply(ClientEvent::SurfaceImages(Arc::new(images)));
    assert!(state.surface_images.get(&key).is_some());
    // A daemon naming a file for this client is never followed.
    let before = state.surface_images.clone();
    state.apply(ClientEvent::Message(ServerMessage::GraphicsFile {
        path: "/etc/passwd".into(),
        expected_len: 4,
        image_id: 1,
        transfer_id: 1,
        leading: vec![],
        control: String::new(),
        surface_asset: Some(key.clone()),
    }));
    assert!(Arc::ptr_eq(&before, &state.surface_images));
    state.apply(ClientEvent::Disconnected {
        reason: "test".into(),
        ssh: None,
    });
    assert!(state.surface_images.is_empty());
}
