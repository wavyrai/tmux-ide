use super::*;

fn bridge() -> ConnectionBridge {
    ConnectionBridge::new(ConnectTarget::Socket("/unused-connection-test.sock".into()))
}

#[test]
fn host_theme_paints_cell_colors_and_follows_system_appearance() {
    let theme = Theme {
        foreground: 0xabcdef,
        background: 0x010203,
        ..Theme::default()
    };
    let dark = host_theme(&theme, false);
    assert_eq!(dark.appearance, ClientHostAppearance::Dark);
    assert_eq!(
        dark.foreground,
        ClientHostColor {
            r: 0xab,
            g: 0xcd,
            b: 0xef
        }
    );
    assert_eq!(dark.background, ClientHostColor { r: 1, g: 2, b: 3 });
    assert!(
        dark.palette
            .iter()
            .zip(theme.palette)
            .all(|(color, packed)| (u32::from(color.r) << 16
                | u32::from(color.g) << 8
                | u32::from(color.b))
                == packed)
    );
    // A dark background under a light system still reports light.
    let light = host_theme(&theme, true);
    assert_eq!(light.appearance, ClientHostAppearance::Light);
    assert_eq!(light.palette, dark.palette);
}

#[test]
fn settings_reload_is_coalesced_consumed_once_and_connection_fenced() {
    let mut bridge = bridge();
    for _ in 0..3 {
        bridge.inbox.lock().unwrap().apply(ClientEvent::Message(
            herdr_client::protocol::ServerMessage::ReloadSoundConfig,
        ));
    }
    let update = bridge.take_update().unwrap();
    assert!(!update.settings_reload);
    assert!(update.reload_sound);
    let guard = bridge.inbox.lock().unwrap();
    assert!(!bridge.take_settings_reload());
    drop(guard);
    assert!(bridge.take_settings_reload());
    assert!(!bridge.take_settings_reload());
    bridge.inbox.lock().unwrap().apply(ClientEvent::Message(
        herdr_client::protocol::ServerMessage::ReloadSoundConfig,
    ));
    assert!(bridge.take_settings_reload());
    assert!(bridge.take_update().unwrap().reload_sound);
    bridge.inbox.lock().unwrap().set_outer_focus(true);
    assert!(!bridge.take_update().unwrap().reload_sound);
    let old = bridge.inbox.clone();
    old.lock().unwrap().settings_reload = true;
    bridge.detach(false);
    assert!(!bridge.take_settings_reload());
    old.lock().unwrap().apply(ClientEvent::Message(
        herdr_client::protocol::ServerMessage::ReloadSoundConfig,
    ));
    assert!(!bridge.take_settings_reload());
    bridge.inbox.lock().unwrap().apply(ClientEvent::Message(
        herdr_client::protocol::ServerMessage::ReloadSoundConfig,
    ));
    bridge
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Disconnected {
            reason: "closed".into(),
            ssh: None,
        });
    assert!(!bridge.take_settings_reload());
}

#[test]
fn integration_responses_do_not_overwrite_dialog_responses() {
    let mut integrations = IntegrationInbox {
        pending: Some(("integration".into(), None)),
        ..Default::default()
    };
    let mut state = LiveState::default();
    state.dialog_response = Some(("dialog".into(), None));
    for (id, response) in [
        (
            "integration",
            serde_json::json!({"result":{"type":"integration_list"}}),
        ),
        (
            "dialog",
            serde_json::json!({"result":{"type":"worktree_list"}}),
        ),
    ] {
        if let Some(event) = integrations.apply(ClientEvent::Response {
            request_id: id.into(),
            response,
        }) {
            state.apply(event);
        }
    }
    assert_eq!(
        integrations.pending.unwrap().1.unwrap().unwrap()["result"]["type"],
        "integration_list"
    );
    assert_eq!(
        state.dialog_response.unwrap().1.unwrap().unwrap()["result"]["type"],
        "worktree_list"
    );
}

#[test]
fn integration_rejections_are_correlated_and_disconnect_revokes_capabilities() {
    let mut inbox = IntegrationInbox {
        list: true,
        install: true,
        pending: Some(("install".into(), None)),
    };
    assert!(
        inbox
            .apply(ClientEvent::CommandRejected {
                request_id: Some("other".into()),
                reason: herdr_client::Error::CommandBoot,
            })
            .is_some()
    );
    assert!(inbox.pending.as_ref().unwrap().1.is_none());
    assert!(
        inbox
            .apply(ClientEvent::CommandRejected {
                request_id: Some("install".into()),
                reason: herdr_client::Error::CommandBoot,
            })
            .is_none()
    );
    assert!(matches!(
        inbox.pending.as_ref().unwrap().1,
        Some(Err(crate::Error::Client(herdr_client::Error::CommandBoot)))
    ));
    assert!(
        inbox
            .apply(ClientEvent::Disconnected {
                reason: "closed".into(),
                ssh: None,
            })
            .is_some()
    );
    assert!(!inbox.list && !inbox.install);
    assert!(matches!(
        inbox.pending.unwrap().1,
        Some(Err(crate::Error::NotConnected))
    ));
}

#[test]
fn integration_mailbox_is_fenced_on_detach() {
    let mut bridge = bridge();
    let old = bridge.integrations.clone();
    old.lock().unwrap().list = true;
    old.lock().unwrap().pending = Some(("old".into(), None));
    bridge.detach(false);
    old.lock().unwrap().apply(ClientEvent::Response {
        request_id: "old".into(),
        response: serde_json::json!({"result":{}}),
    });
    assert!(!Arc::ptr_eq(&old, &bridge.integrations));
    let inbox = bridge.integrations.lock().unwrap();
    assert!(!inbox.list && !inbox.install && inbox.pending.is_none());
}

#[test]
fn bells_move_once_titles_persist_and_old_inboxes_are_fenced() {
    use herdr_client::protocol::ServerMessage;
    let mut bridge = bridge();
    let old = bridge.inbox.clone();
    {
        let mut state = old.lock().unwrap();
        state.status = ConnectionStatus::Connected;
        state.apply(ClientEvent::Message(ServerMessage::TerminalBell {
            count: 2,
        }));
        state.apply(ClientEvent::Message(ServerMessage::WindowTitle {
            title: Some("agent".into()),
        }));
    }
    let update = bridge.take_update().unwrap();
    assert_eq!(update.bells, 2);
    assert_eq!(update.window_title.as_deref(), Some("agent"));
    old.lock().unwrap().set_outer_focus(true);
    let next = bridge.take_update().unwrap();
    assert_eq!(next.bells, 0, "a bell is delivered once");
    assert_eq!(
        next.window_title.as_deref(),
        Some("agent"),
        "a title is state"
    );

    bridge.reset(ConnectionStatus::Connected, false);
    {
        let mut state = old.lock().unwrap();
        state.apply(ClientEvent::Message(ServerMessage::TerminalBell {
            count: 1,
        }));
        state.apply(ClientEvent::Message(ServerMessage::WindowTitle {
            title: Some("late".into()),
        }));
    }
    let replacement = bridge.take_update().unwrap();
    assert_eq!(replacement.bells, 0);
    assert_eq!(replacement.window_title, None);
}

#[test]
fn notifications_move_once_are_bounded_and_fenced_by_replacement() {
    use crate::notifications::{PENDING_LIMIT, tests::notification};
    use herdr_client::protocol::ServerMessage;
    let mut bridge = bridge();
    let old = bridge.inbox.clone();
    {
        let mut state = old.lock().unwrap();
        state.status = ConnectionStatus::Connected;
        for id in 0..100 {
            state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
                notification(&id.to_string()),
            )));
        }
        state.set_outer_focus(true);
    }
    let update = bridge.take_update().unwrap();
    assert_eq!(update.notifications.len(), PENDING_LIMIT);
    assert_eq!(update.notifications[0].title, "92");
    assert_eq!(update.notifications[7].title, "99");
    assert_eq!(update.sound_events.len(), crate::sound::MAX_PENDING);
    assert_eq!(update.sound_events[0].1.title, "68");
    assert_eq!(update.sound_events[31].1.title, "99");
    assert!(bridge.take_update().is_none());
    old.lock().unwrap().set_outer_focus(false);
    let next = bridge.take_update().unwrap();
    assert!(next.notifications.is_empty());
    assert!(next.sound_events.is_empty());
    bridge.detach(false);
    assert!(update.sound_cancel.load(Ordering::Acquire));
    old.lock()
        .unwrap()
        .apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            notification("late"),
        )));
    let detached = bridge.take_update().unwrap();
    assert!(detached.notifications.is_empty());
    assert!(detached.sound_events.is_empty());
    bridge.reset(ConnectionStatus::Connected, false);
    old.lock()
        .unwrap()
        .apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            notification("late again"),
        )));
    let replacement = bridge.take_update().unwrap();
    assert!(replacement.notifications.is_empty());
    assert!(replacement.sound_events.is_empty());
    {
        let mut state = bridge.inbox.lock().unwrap();
        state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            notification("discard on disconnect"),
        )));
        state.apply(ClientEvent::Disconnected {
            reason: "test".into(),
            ssh: None,
        });
    }
    let disconnected = bridge.take_update().unwrap();
    assert!(disconnected.notifications.is_empty());
    assert!(disconnected.sound_events.is_empty());
    assert!(disconnected.sound_cancel.load(Ordering::Acquire));
}

#[test]
fn clipboard_writes_move_out_of_the_mailbox_exactly_once() {
    use herdr_client::protocol::ServerMessage;
    let bridge = bridge();
    bridge
        .inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Message(ServerMessage::Clipboard {
            data: "aGVsbG8=".into(),
        }));
    let update = bridge.take_update().unwrap();
    assert_eq!(
        update
            .clipboard_writes
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["hello"]
    );
    // Already delivered, so a poll without new work yields nothing.
    assert!(bridge.take_update().is_none());
    bridge.inbox.lock().unwrap().dirty = true;
    assert!(bridge.take_update().unwrap().clipboard_writes.is_empty());
}

#[test]
fn contended_retirement_cancels_audio_after_boot_token_replacement() {
    for detach in [false, true] {
        let mut bridge = bridge();
        let inbox = bridge.inbox.clone();
        let mut held = inbox.lock().unwrap();
        held.sound_cancel = Arc::new(AtomicBool::new(false));
        if detach {
            bridge.detach(false);
            assert!(!bridge.sound_cancel.load(Ordering::Acquire));
        } else {
            drop(bridge);
        }
        assert!(held.sound_connection_cancel.load(Ordering::Acquire));
    }
}

#[test]
fn synchronous_startup_failure_survives_mailbox_and_focus_updates() {
    let mut bridge = bridge();
    let mut options = ConnectOptions::default();
    options.surface_size.cols = 0;
    bridge.reconnect(options, true, true);
    let failed = bridge.take_update().unwrap();
    assert_eq!(failed.status, ConnectionStatus::Disconnected);
    assert!(failed.error.is_some());
    assert!(bridge.handle.is_none());
    assert!(bridge.take_update().is_none());
    bridge.inbox.lock().unwrap().set_outer_focus(false);
    let next = bridge.take_update().unwrap();
    assert_eq!(next.status, failed.status);
    assert_eq!(next.error, failed.error);
}

#[test]
fn event_reader_startup_failure_is_authoritative() {
    let mut bridge = bridge();
    bridge.start(ConnectOptions::default(), true, |_| {
        Err(std::io::Error::other("reader startup failed"))
    });
    let state = bridge.take_update().unwrap();
    assert_eq!(state.status, ConnectionStatus::Disconnected);
    assert_eq!(state.error.as_deref(), Some("reader startup failed"));
    assert!(bridge.handle.is_none());
    bridge.inbox.lock().unwrap().set_outer_focus(true);
    assert_eq!(
        bridge.take_update().unwrap().status,
        ConnectionStatus::Disconnected
    );
}

#[test]
fn detach_and_reconnect_fence_old_inboxes() {
    let mut bridge = bridge();
    let old = bridge.inbox.clone();
    old.lock().unwrap().local_daemon_peer = true;
    old.lock().unwrap().dialog_response = Some(("remove".into(), None));
    bridge.detach(true);
    old.lock().unwrap().apply(ClientEvent::Response {
        request_id: "remove".into(),
        response: serde_json::json!({"error":{"code":"dirty_worktree_requires_force"}}),
    });
    old.lock().unwrap().missing_installation = true;
    old.lock().unwrap().apply(ClientEvent::Disconnected {
        reason: "old connection".into(),
        ssh: None,
    });
    let detached = bridge.take_update().unwrap();
    assert_eq!(detached.status, ConnectionStatus::Detached);
    assert!(!detached.missing_installation);
    assert!(!detached.local_daemon_peer);
    assert!(detached.error.is_none());
    assert!(detached.dialog_response.is_none());
    assert!(detached.snapshot.is_none() && detached.surface.is_none());
    let old = bridge.inbox.clone();
    old.lock().unwrap().local_daemon_peer = true;
    let mut options = ConnectOptions::default();
    options.surface_size.cols = 0;
    bridge.reconnect(options, false, true);
    old.lock().unwrap().apply(ClientEvent::Disconnected {
        reason: "detached connection".into(),
        ssh: None,
    });
    let failed = bridge.take_update().unwrap();
    assert_eq!(failed.status, ConnectionStatus::Disconnected);
    assert!(!failed.local_daemon_peer);
    assert_ne!(failed.error.as_deref(), Some("detached connection"));
    assert!(!Arc::ptr_eq(&old, &bridge.inbox));
}

#[test]
fn dialog_result_moves_out_once_without_losing_pending_registration() {
    let bridge = bridge();
    bridge.inbox.lock().unwrap().dialog_response = Some(("list".into(), None));
    assert!(matches!(
        bridge.take_update().unwrap().dialog_response,
        Some((id, None)) if id == "list"
    ));
    bridge.inbox.lock().unwrap().apply(ClientEvent::Response {
        request_id: "list".into(),
        response: serde_json::json!({"result":{}}),
    });
    assert!(
        bridge
            .take_update()
            .unwrap()
            .dialog_response
            .unwrap()
            .1
            .is_some()
    );
    bridge.inbox.lock().unwrap().set_outer_focus(true);
    assert!(matches!(
        bridge.take_update().unwrap().dialog_response,
        Some((id, None)) if id == "list"
    ));
}
