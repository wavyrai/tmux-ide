use super::*;

fn send(service: &Service, boot: Option<&str>, event: SemanticNotification, queued: Instant) {
    service
        .sender
        .as_ref()
        .unwrap()
        .send(Job {
            request: PlaybackRequest::Notification {
                boot: boot.map(str::to_owned),
                event,
            },
            cancel: Arc::new(AtomicBool::new(false)),
            connection_cancel: Arc::new(AtomicBool::new(false)),
            queued,
        })
        .unwrap();
}

#[test]
fn recent_accepts_one_copy_per_boot_and_event_within_the_window() {
    let mut recent = Recent::default();
    let now = Instant::now();
    let finished = event(Kind::Finished);
    assert!(recent.first(Some("boot"), &finished, now));
    // A window that polled first may stamp its copy earlier than the one played.
    assert!(!recent.first(Some("boot"), &finished, now - Duration::from_millis(100)));
    assert!(!recent.first(Some("boot"), &finished, now + Duration::from_millis(100)));
    assert!(recent.first(Some("other"), &finished, now));
    assert!(recent.first(None, &finished, now));
    let mut attention = finished.clone();
    attention.kind = Kind::NeedsAttention;
    assert!(recent.first(Some("boot"), &attention, now));
    assert!(recent.first(Some("boot"), &finished, now + REPEAT_WINDOW));
}

#[test]
fn recent_stays_bounded() {
    let mut recent = Recent::default();
    let now = Instant::now();
    for index in 0..MAX_PENDING * 2 {
        let mut notification = event(Kind::Custom);
        notification.title = index.to_string();
        assert!(recent.first(Some("boot"), &notification, now));
    }
    assert_eq!(recent.0.len(), MAX_PENDING);
}

#[test]
fn worker_plays_a_notification_every_window_received_once() {
    let (service, played) = Service::recording();
    let now = Instant::now();
    // Two windows attached to one daemon each hand the worker the same event.
    send(&service, Some("boot"), event(Kind::Finished), now);
    send(&service, Some("boot"), event(Kind::Finished), now);
    // A different daemon's identical-looking event still plays.
    send(&service, Some("remote"), event(Kind::Finished), now);
    for _ in 0..2 {
        assert_eq!(
            played.recv_timeout(Duration::from_secs(3)).unwrap(),
            Sound::Done
        );
    }
    drop(service);
    assert!(matches!(
        played.recv_timeout(Duration::from_secs(3)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}
