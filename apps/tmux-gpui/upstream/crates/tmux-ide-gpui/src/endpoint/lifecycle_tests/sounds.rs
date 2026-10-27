use super::*;

#[gpui::test]
#[cfg(feature = "qa-menu")]
fn qa_play_sound_dispatches_without_daemon_or_pane(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let (sound, played) = crate::sound::Service::recording();
    view.update(cx, |view, _| {
        view.sound = sound.into();
        for endpoint in &mut view.endpoints {
            endpoint.stop();
            endpoint.live = Default::default();
        }
    });
    cx.update(|window, cx| {
        view.read(cx).focus.clone().focus(window, cx);
        window.draw(cx).clear(cx);
        let menus = crate::menus(Default::default());
        let qa = menus
            .iter()
            .find(|menu| menu.name.as_ref() == "QA")
            .unwrap();
        let action = qa
            .items
            .iter()
            .find_map(|item| match item {
                gpui::MenuItem::Action { name, action, .. } if name.as_ref() == "Play Sound" => {
                    Some(action)
                }
                _ => None,
            })
            .unwrap();
        assert!(action.partial_eq(&crate::PlaySound));
        window.dispatch_action(action.boxed_clone(), cx);
    });
    assert_eq!(
        played.recv_timeout(Duration::from_secs(3)).unwrap(),
        SemanticNotificationSound::Done
    );
    view.update(cx, |view, _| {
        for endpoint in &view.endpoints {
            assert!(endpoint.live.snapshot.is_none());
            assert!(endpoint.live.sound_events.is_empty());
        }
        view.sound = Default::default();
    });
    assert!(matches!(
        played.recv_timeout(Duration::from_secs(3)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
    ));
}

#[gpui::test]
fn inactive_endpoint_semantic_sound_reaches_worker_once(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (remote, mut server) = connected_endpoint("ssh:sound");
    let (sound, played) = crate::sound::Service::recording();
    view.update(cx, |view, _| {
        view.sound = sound.into();
        view.endpoints[0].detached = true;
        view.endpoints.push(remote);
        assert_eq!(view.selected_endpoint, 0);
    });
    for message in [
        ServerMessage::Notify {
            kind: NotifyKind::Sound,
            message: "legacy".into(),
            body: None,
        },
        ServerMessage::TerminalBell { count: 1 },
        ServerMessage::SemanticNotification(SemanticNotification {
            kind: SemanticNotificationKind::Custom,
            title: "test".into(),
            body: None,
            sound: Some(SemanticNotificationSound::Request),
            agent: None,
            workspace_id: None,
            tab_id: None,
            pane_id: None,
            position: None,
        }),
    ] {
        write_message(&mut server.stream, &message, MAX_FRAME_SIZE).unwrap();
    }
    view.update(cx, |view, cx| {
        wait_until(|| {
            view.poll_endpoints(cx);
            match played.try_recv() {
                Ok(sound) => {
                    assert_eq!(sound, SemanticNotificationSound::Request);
                    true
                }
                Err(_) => false,
            }
        });
        assert!(view.endpoints[1].live.sound_events.is_empty());
        // Subsequent coalesced updates cannot redeliver the moved event.
        view.endpoints[1]
            .connection
            .inbox
            .lock()
            .unwrap()
            .set_outer_focus(true);
        view.poll_endpoints(cx);
        assert!(played.try_recv().is_err());
        view.endpoints[1].stop();
    });
}
