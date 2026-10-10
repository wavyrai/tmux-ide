use super::*;

fn dismissed(request: &str) -> LiveState {
    let mut state = LiveState::default();
    state.apply(ClientEvent::Snapshot(snapshot()));
    assert_eq!(
        state.product_announcement().map(|a| a.id.as_str()),
        Some("announcement-v1")
    );
    state.announcement_dismissal = Some(AnnouncementDismissal {
        request: Some(request.into()),
        version: "1.0.0".into(),
        id: "announcement-v1".into(),
    });
    assert!(state.product_announcement().is_none());
    state
}

#[test]
fn dismissed_announcement_stays_hidden_until_the_daemon_drops_it() {
    let mut state = dismissed("dismiss-1");
    state.apply(ClientEvent::Response {
        request_id: "dismiss-1".into(),
        response: serde_json::json!({"result": {"type": "ok"}}),
    });
    // A snapshot that still carries it, sent before the daemon handled
    // the request, must not bring the card back.
    state.apply(ClientEvent::Snapshot(snapshot()));
    assert!(state.product_announcement().is_none());
    assert!(state.error.is_none());

    let mut dropped = (*snapshot()).clone();
    dropped.product_announcement = None;
    state.apply(ClientEvent::Snapshot(Arc::new(dropped)));
    assert!(state.announcement_dismissal.is_none());

    // A new announcement is never covered by an old dismissal.
    let mut next = (*snapshot()).clone();
    if let Some(announcement) = &mut next.product_announcement {
        announcement.id = "announcement-v2".into();
    }
    let mut state = dismissed("dismiss-2");
    state.apply(ClientEvent::Snapshot(Arc::new(next)));
    assert_eq!(
        state.product_announcement().map(|a| a.id.as_str()),
        Some("announcement-v2")
    );
}

#[test]
fn rejected_dismissal_shows_the_announcement_again() {
    let mut state = dismissed("dismiss-1");
    state.apply(ClientEvent::Response {
        request_id: "other".into(),
        response: serde_json::json!({"error": {"code": "x", "message": "y"}}),
    });
    assert!(state.product_announcement().is_none());
    state.error = None;
    state.apply(ClientEvent::Response {
        request_id: "dismiss-1".into(),
        response: serde_json::json!({"error": {
            "code": "stale_announcement",
            "message": "the product announcement is no longer current"
        }}),
    });
    assert!(state.product_announcement().is_some());
    // The card coming back is the feedback; the status line stays quiet.
    assert!(state.error.is_none());

    let mut state = dismissed("dismiss-2");
    state.apply(ClientEvent::CommandRejected {
        request_id: Some("dismiss-2".into()),
        reason: herdr_client::Error::Disconnected,
    });
    assert!(state.product_announcement().is_some());
}

#[test]
fn dismissal_is_part_of_the_window_state() {
    let state = dismissed("dismiss-1");
    let mut next = state.clone();
    assert!(state.only_surface_changed(&next));
    next.announcement_dismissal = None;
    assert!(!state.only_surface_changed(&next));
}
