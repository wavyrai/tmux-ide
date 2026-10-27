#![allow(clippy::unwrap_used)]
use super::*;
use crate::connection::ConnectionBridge;
use herdr_client::{
    ClientEvent, ConnectTarget,
    protocol::{ClientShellSnapshot, SemanticNotificationSound as Sound, ServerMessage},
};

fn live(status: AgentStatus) -> LiveState {
    let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    snapshot.agents.truncate(1);
    snapshot.agents[0].pane_id = "pane".into();
    snapshot.agents[0].agent_status = status;
    snapshot.focused_tab_id = Some("tab".into());
    snapshot.focused_workspace_id = Some("workspace".into());
    let mut live = LiveState::default();
    live.apply(ClientEvent::Snapshot(Arc::new(snapshot)));
    live
}

fn event(kind: Kind) -> SemanticNotification {
    SemanticNotification {
        kind,
        title: "test".into(),
        body: None,
        sound: Some(Sound::Done),
        agent: Some("claude".into()),
        workspace_id: Some("workspace".into()),
        tab_id: Some("tab".into()),
        pane_id: Some("pane".into()),
        position: None,
    }
}

#[test]
fn bridge_moves_bounded_notifications_and_reload_once() {
    let bridge = ConnectionBridge::new(ConnectTarget::Socket("/unused-sound.sock".into()));
    {
        let mut state = bridge.inbox.lock().unwrap();
        state.status = crate::state::ConnectionStatus::Connected;
        for i in 0..MAX_PENDING + 5 {
            let mut event = event(Kind::Custom);
            event.title = i.to_string();
            state.apply(ClientEvent::Message(ServerMessage::SemanticNotification(
                event,
            )));
        }
        state.apply(ClientEvent::Message(ServerMessage::ReloadSoundConfig));
    }
    let first = bridge.take_update().unwrap();
    assert_eq!(first.sound_events.len(), MAX_PENDING);
    assert_eq!(first.sound_events[0].1.title, "5");
    // Toast coalescing must not consume the independent sound delivery queue.
    assert_eq!(first.notifications.len(), 1);
    assert_eq!(first.notifications[0].title, (MAX_PENDING + 4).to_string());
    assert!(first.reload_sound);
    assert!(bridge.take_update().is_none());
    bridge.inbox.lock().unwrap().set_outer_focus(true);
    let next = bridge.take_update().unwrap();
    assert!(next.sound_events.is_empty());
    assert!(next.notifications.is_empty());
    assert!(!next.reload_sound);
}

#[test]
fn delayed_validation_and_zero_delay_attention_match_tui() {
    for (kind, status, delay, count) in [
        (Kind::NeedsAttention, AgentStatus::Blocked, 1, 1),
        (Kind::NeedsAttention, AgentStatus::Working, 1, 0),
        (Kind::NeedsAttention, AgentStatus::Working, 0, 1),
        (Kind::Finished, AgentStatus::Done, 1, 1),
        (Kind::Finished, AgentStatus::Idle, 0, 0),
        (Kind::Finished, AgentStatus::Working, 1, 0),
    ] {
        let now = Instant::now();
        let mut state = live(status);
        state.sound_events.push_back((now, event(kind)));
        let mut policy = Policy::default();
        let mut sounds = Vec::new();
        policy.poll(&mut state, Some(delay), false, now, |e| sounds.push(e));
        if delay > 0 {
            assert!(sounds.is_empty());
        }
        policy.poll(
            &mut state,
            Some(delay),
            false,
            now + Duration::from_secs(1),
            |e| sounds.push(e),
        );
        assert_eq!(sounds.len(), count, "{kind:?}, {status:?}, {delay}");
        policy.poll(
            &mut state,
            Some(delay),
            false,
            now + Duration::from_secs(5),
            |_| panic!("replayed sound"),
        );
    }
}

#[test]
fn completion_grace_rechecks_working_and_missing_agents_but_not_idle() {
    for missing in [false, true] {
        let now = Instant::now();
        let mut state = live(AgentStatus::Working);
        if missing {
            Arc::make_mut(state.snapshot.as_mut().unwrap())
                .agents
                .clear();
        }
        state.sound_events.push_back((now, event(Kind::Finished)));
        let mut policy = Policy::default();
        policy.poll(&mut state, Some(0), false, now, |_| {
            panic!("premature completion")
        });
        assert_eq!(policy.pending.len(), 1);
        state.snapshot = live(AgentStatus::Done).snapshot;
        let mut count = 0;
        policy.poll(
            &mut state,
            Some(0),
            false,
            now + Duration::from_millis(50),
            |_| count += 1,
        );
        assert_eq!(count, 1);
    }
    let now = Instant::now();
    let mut state = live(AgentStatus::Working);
    state.sound_events.push_back((now, event(Kind::Finished)));
    let mut policy = Policy::default();
    policy.poll(&mut state, Some(0), false, now, |_| panic!());
    policy.poll(
        &mut state,
        Some(0),
        false,
        now + Duration::from_secs(1),
        |_| panic!(),
    );
    assert!(policy.pending.is_empty());
    state.snapshot = live(AgentStatus::Done).snapshot;
    policy.poll(
        &mut state,
        Some(0),
        false,
        now + Duration::from_secs(2),
        |_| panic!("expired completion"),
    );
}

#[test]
fn focus_suppresses_only_finished_for_selected_focused_tab() {
    for kind in [
        Kind::Finished,
        Kind::NeedsAttention,
        Kind::Custom,
        Kind::UpdateInstalled,
    ] {
        for focused in [false, true] {
            for active_tab in [false, true] {
                let now = Instant::now();
                let mut state = live(AgentStatus::Done);
                let mut notification = event(kind);
                if !active_tab {
                    notification.tab_id = Some("other-tab".into());
                }
                state.sound_events.push_back((now, notification));
                let mut count = 0;
                Policy::default().poll(&mut state, Some(0), focused, now, |_| count += 1);
                assert_eq!(
                    count,
                    usize::from(!(kind == Kind::Finished && focused && active_tab))
                );
            }
        }
    }
}

#[test]
fn custom_is_immediate_and_each_immediate_event_moves_once() {
    let now = Instant::now();
    let mut state = live(AgentStatus::Idle);
    state.sound_events.push_back((now, event(Kind::Custom)));
    state.sound_events.push_back((now, event(Kind::Custom)));
    let mut count = 0;
    let mut policy = Policy::default();
    policy.poll(&mut state, Some(3600), true, now, |_| count += 1);
    assert_eq!(count, 2);
    assert!(state.sound_events.is_empty() && policy.pending.is_empty());
}

#[test]
fn replacement_is_per_endpoint_and_pane_even_without_sound() {
    let now = Instant::now();
    let mut first = live(AgentStatus::Blocked);
    let mut second = live(AgentStatus::Blocked);
    let mut policies = [Policy::default(), Policy::default()];
    for (policy, state) in policies.iter_mut().zip([&mut first, &mut second]) {
        state
            .sound_events
            .push_back((now, event(Kind::NeedsAttention)));
        policy.poll(state, Some(1), false, now, |_| panic!());
    }
    let mut replacement = event(Kind::Custom);
    replacement.sound = None;
    first.sound_events.push_back((now, replacement));
    policies[0].poll(
        &mut first,
        Some(1),
        false,
        now + Duration::from_secs(1),
        |_| panic!("replaced"),
    );
    let mut count = 0;
    policies[1].poll(
        &mut second,
        Some(1),
        false,
        now + Duration::from_secs(1),
        |_| count += 1,
    );
    assert_eq!(count, 1);
}

#[test]
fn no_pane_completion_is_rejected_and_workspace_focus_is_fallback() {
    let now = Instant::now();
    let mut state = live(AgentStatus::Done);
    let mut notification = event(Kind::Finished);
    notification.pane_id = None;
    state.sound_events.push_back((now, notification));
    let mut policy = Policy::default();
    policy.poll(&mut state, Some(0), false, now, |_| panic!());
    let mut notification = event(Kind::Finished);
    notification.tab_id = None;
    state.sound_events.push_back((now, notification));
    policy.poll(&mut state, Some(0), true, now, |_| panic!());
}

#[test]
fn startup_buffer_and_pending_are_bounded() {
    let now = Instant::now();
    let mut state = live(AgentStatus::Blocked);
    let mut policy = Policy::default();
    for _ in 0..3 {
        for i in 0..MAX_PENDING {
            let mut notification = event(Kind::NeedsAttention);
            notification.pane_id = Some(i.to_string());
            state.sound_events.push_back((now, notification));
        }
        policy.poll(&mut state, None, false, now, |_| panic!());
    }
    assert_eq!(policy.incoming.len(), MAX_PENDING);
    policy.poll(&mut state, Some(3600), false, now, |_| panic!());
    assert_eq!(policy.pending.len(), MAX_PENDING);
    assert!(policy.incoming.is_empty());
}

#[test]
fn disconnect_boot_and_detach_cancel_pending_and_queued_generations() {
    let now = Instant::now();
    for boot_change in [false, true] {
        let mut state = live(AgentStatus::Done);
        let token = state.sound_cancel.clone();
        state.sound_events.push_back((now, event(Kind::Finished)));
        let mut policy = Policy::default();
        policy.poll(&mut state, Some(1), false, now, |_| panic!());
        if boot_change {
            let mut snapshot = state.snapshot.clone().unwrap();
            Arc::make_mut(&mut snapshot).boot_id = "new-boot".into();
            state.apply(ClientEvent::Snapshot(snapshot));
        } else {
            state.apply(ClientEvent::Disconnected {
                reason: "test".into(),
                ssh: None,
            });
        }
        assert!(token.load(Ordering::Acquire));
        policy.poll(
            &mut state,
            Some(1),
            false,
            now + Duration::from_secs(1),
            |_| panic!("retired generation"),
        );
        assert!(policy.pending.is_empty());
    }
    let mut bridge = ConnectionBridge::new(ConnectTarget::Socket("/unused-sound.sock".into()));
    let old = bridge.inbox.clone();
    let token = old.lock().unwrap().sound_cancel.clone();
    bridge.detach(false);
    assert!(token.load(Ordering::Acquire));
    old.lock()
        .unwrap()
        .apply(ClientEvent::Message(ServerMessage::SemanticNotification(
            event(Kind::Custom),
        )));
    assert!(bridge.take_update().unwrap().sound_events.is_empty());
    let token = bridge.inbox.lock().unwrap().sound_cancel.clone();
    drop(bridge);
    assert!(token.load(Ordering::Acquire));
}

#[test]
fn service_nonblocking_queue_bound_reload_and_move_once() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let service = Service {
        sender: Some(sender),
        settings: Arc::new(Mutex::new(Some(Arc::new(Settings::default())))),
        reload: Default::default(),
        stop: Default::default(),
    };
    let mut state = live(AgentStatus::Idle);
    let now = Instant::now();
    state.reload_sound = true;
    for _ in 0..3 {
        state.sound_events.push_back((now, event(Kind::Custom)));
    }
    let mut policy = Policy::default();
    service.poll(&mut policy, &mut state, false, now);
    assert!(service.reload.load(Ordering::Acquire));
    assert!(!state.reload_sound);
    assert!(receiver.try_recv().is_ok());
    assert!(receiver.try_recv().is_err());
    service.poll(&mut policy, &mut state, false, now);
    assert!(receiver.try_recv().is_err());
}

#[test]
fn preview_uses_builtin_on_worker_despite_notification_mute() {
    let caller = std::thread::current().id();
    let (sender, played) = mpsc::sync_channel(8);
    let service = Service::start(
        move || {
            assert_ne!(std::thread::current().id(), caller);
            let mut settings = Settings::default();
            settings.sound = toml::from_str(
                "enabled = false\ndone_path = '/unused-custom.mp3'\n[agents]\nclaude = 'off'",
            )
            .unwrap();
            Ok(settings)
        },
        move |sound, path, cancel, stop| {
            assert_ne!(std::thread::current().id(), caller);
            assert!(path.is_none());
            assert!(cancel.iter().all(|flag| !flag.load(Ordering::Acquire)));
            assert!(!stop.load(Ordering::Acquire));
            sender.send(sound).unwrap();
            Ok(())
        },
    );
    service
        .sender
        .as_ref()
        .unwrap()
        .send(Job {
            request: PlaybackRequest::Notification {
                boot: None,
                event: event(Kind::Custom),
            },
            cancel: Arc::new(AtomicBool::new(false)),
            connection_cancel: Arc::new(AtomicBool::new(false)),
            queued: Instant::now(),
        })
        .unwrap();
    service.preview();
    assert_eq!(
        played.recv_timeout(Duration::from_secs(3)).unwrap(),
        Sound::Done
    );
    drop(service);
    assert!(matches!(
        played.recv_timeout(Duration::from_secs(3)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}

#[test]
fn preview_queue_is_bounded_and_uses_service_cancellation() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let service = Service {
        sender: Some(sender),
        settings: Default::default(),
        reload: Default::default(),
        stop: Default::default(),
    };
    service.preview();
    service.preview();
    let job = receiver.try_recv().unwrap();
    assert!(matches!(job.request, PlaybackRequest::Preview));
    assert!(Arc::ptr_eq(&job.cancel, &service.stop));
    assert!(receiver.try_recv().is_err());
    drop(service);
    assert!(job.cancel.load(Ordering::Acquire));
    // Normal constructors in unit/headless tests must never open a real device.
    let suppressed = Service::new();
    suppressed.preview();
    assert!(suppressed.sender.is_none());
}

#[test]
fn worker_continues_after_backend_error_without_replaying() {
    let (sender, played) = mpsc::sync_channel(8);
    let mut first = true;
    let service = Service::start(
        || Ok(Settings::default()),
        move |sound, _, _, _| {
            sender.send(sound).unwrap();
            if std::mem::take(&mut first) {
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe).into());
            }
            Ok(())
        },
    );
    for sound in [Sound::Done, Sound::Request] {
        let mut notification = event(Kind::Custom);
        notification.sound = Some(sound);
        service
            .sender
            .as_ref()
            .unwrap()
            .send(Job {
                request: PlaybackRequest::Notification {
                    boot: None,
                    event: notification,
                },
                cancel: Arc::new(AtomicBool::new(false)),
                connection_cancel: Arc::new(AtomicBool::new(false)),
                queued: Instant::now(),
            })
            .unwrap();
        assert_eq!(played.recv_timeout(Duration::from_secs(3)).unwrap(), sound);
    }
    drop(service);
    assert!(matches!(
        played.recv_timeout(Duration::from_secs(3)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}

#[test]
fn worker_drops_cancelled_and_expired_jobs_without_playing_them() {
    let (service, played) = Service::recording();
    for (cancelled, age) in [(true, 0), (false, 2), (false, 0)] {
        service
            .sender
            .as_ref()
            .unwrap()
            .send(Job {
                request: PlaybackRequest::Notification {
                    boot: None,
                    event: event(Kind::Custom),
                },
                cancel: Arc::new(AtomicBool::new(cancelled)),
                connection_cancel: Arc::new(AtomicBool::new(false)),
                queued: Instant::now() - Duration::from_secs(age),
            })
            .unwrap();
    }
    assert_eq!(
        played.recv_timeout(Duration::from_secs(3)).unwrap(),
        Sound::Done
    );
    drop(service);
    assert!(matches!(
        played.recv_timeout(Duration::from_secs(3)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}

mod repeats;
