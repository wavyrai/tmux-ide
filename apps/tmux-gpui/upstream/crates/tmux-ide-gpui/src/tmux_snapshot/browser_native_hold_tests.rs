#![allow(clippy::unwrap_used)]
use super::*;

fn live(request: u64) -> State {
    State {
        surface: Surface::Workspace,
        request,
        selected_session: Some("$1".into()),
        selected_pane: Some("%2".into()),
        input_ready: true,
        frame: Some(DisplayFrame::Native(Arc::new(NativeFrame {
            rows: Vec::new(),
            width: 80,
            height: 24,
            cursor: None,
        }))),
        ..State::default()
    }
}
/// The catalog's state while it reconnects: no live frame for the same request.
fn reconnecting(request: u64, attempt: u32) -> State {
    State {
        request,
        reconnect_attempt: Some(attempt),
        status: "Connection lost. Reconnecting…".into(),
        ..State::default()
    }
}

#[test]
fn a_dropped_stream_keeps_its_last_frame_read_only_with_the_attempt() {
    let mut hold = Hold::default();
    hold.begin(&live(7), false);
    assert!(hold.active());
    let shown = hold.publication(&reconnecting(7, 3));
    assert!(shown.frame.is_some());
    assert!(shown.retained_preview);
    assert!(!shown.input_ready);
    assert_eq!(shown.surface, Surface::Workspace);
    assert_eq!(shown.selected_session.as_deref(), Some("$1"));
    assert_eq!(shown.reconnect_attempt, Some(3));
    assert_eq!(shown.status, "Reconnecting… attempt 3");
    // The held copy hides the stale cursor and is not the live frame itself.
    let Some(DisplayFrame::Native(frame)) = &shown.frame else {
        panic!("expected the held native frame");
    };
    assert!(frame.cursor.is_none());
}

#[test]
fn navigation_a_give_up_or_a_ready_live_frame_ends_the_hold() {
    let mut hold = Hold::default();
    hold.begin(&live(7), false);
    assert!(hold.publication(&reconnecting(8, 1)).frame.is_none());
    assert!(!hold.active());

    hold.begin(&live(7), false);
    let gave_up = State {
        home_phase: HomePhase::Unavailable,
        ..reconnecting(7, 4)
    };
    assert!(hold.publication(&gave_up).frame.is_none());
    assert!(!hold.active());

    hold.begin(&live(7), false);
    // A live frame not yet accepting input is shown, but the hold stays.
    let warming = State {
        input_ready: false,
        ..live(7)
    };
    assert!(!hold.publication(&warming).retained_preview);
    assert!(hold.active());
    assert!(!hold.publication(&live(7)).retained_preview);
    assert!(!hold.active());
}

#[test]
fn nothing_is_held_from_a_preview_from_home_or_without_a_frame() {
    for state in [
        State {
            retained_preview: true,
            ..live(7)
        },
        State {
            surface: Surface::Home,
            ..live(7)
        },
        State {
            frame: None,
            ..live(7)
        },
    ] {
        let mut hold = Hold::default();
        hold.begin(&state, false);
        assert!(!hold.active());
        assert!(hold.publication(&reconnecting(7, 1)).frame.is_none());
    }
}

#[test]
fn the_attempt_count_never_runs_backwards() {
    let mut hold = Hold::default();
    hold.begin(&live(7), false);
    assert_eq!(
        hold.publication(&reconnecting(7, 4)).reconnect_attempt,
        Some(4)
    );
    // Rediscovery's Home publication carries no recovery yet.
    let home = State {
        reconnect_attempt: None,
        ..reconnecting(7, 1)
    };
    let shown = hold.publication(&home);
    assert_eq!(shown.reconnect_attempt, Some(4));
    assert_eq!(shown.status, "Reconnecting… attempt 4");
}

/// A catalog publication can replace the transport's state, frame included, in the
/// same turn the stream fails. The hold then uses the last frame the UI was shown.
#[test]
fn a_frame_wiped_by_a_catalog_publication_is_still_held() {
    let mut hold = Hold::default();
    hold.observe(&live(7));
    let wiped = State {
        frame: None,
        ..live(7)
    };
    hold.begin(&wiped, false);
    assert!(hold.active());
    assert!(hold.publication(&reconnecting(7, 1)).frame.is_some());
    // Never another request's frame.
    let mut hold = Hold::default();
    hold.observe(&live(6));
    hold.begin(&wiped, false);
    assert!(!hold.active());
    // Never a frame the UI was shown as a held copy.
    let mut hold = Hold::default();
    hold.observe(&State {
        retained_preview: true,
        ..live(7)
    });
    hold.begin(&wiped, false);
    assert!(!hold.active());
}

/// Keys in flight when the stream dropped are never replayed; the held status
/// says so, so the user retypes them instead of losing them silently.
#[test]
fn keys_lost_with_the_stream_are_reported_while_reconnecting() {
    let mut hold = Hold::default();
    hold.begin(&live(7), true);
    let shown = hold.publication(&reconnecting(7, 2));
    assert_eq!(
        shown.status,
        format!("Reconnecting… attempt 2 — {LOST_INPUT}")
    );
    let mut hold = Hold::default();
    hold.begin(&live(7), false);
    assert_eq!(
        hold.publication(&reconnecting(7, 2)).status,
        "Reconnecting… attempt 2"
    );
}

/// The legacy pipe catalog never ends a hold (it recovers on its own and
/// publishes no reconnect attempt), so its transport holds no frames: a lost
/// stream clears the frame as before #702.
#[test]
fn a_disabled_hold_never_holds_a_frame() {
    let mut hold = Hold::new(false);
    hold.observe(&live(7));
    hold.begin(&live(7), true);
    assert!(!hold.active(), "the legacy pipe held a frame");
    let shown = hold.publication(&reconnecting(7, 1));
    assert!(shown.frame.is_none(), "a disabled hold published a frame");
}
