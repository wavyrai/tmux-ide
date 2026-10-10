use super::*;

fn lost(boot: &str, revision: u64) -> LiveState {
    let mut live = connected(boot, revision);
    live.status = ConnectionStatus::Disconnected;
    live.snapshot = None;
    live.surface = None;
    live
}

#[test]
fn a_held_frame_outlives_its_connection_until_a_new_frame_is_ready() {
    let mut presentation = Presentation::default();
    let live = connected("boot", 3);
    let first = live.surface.clone().unwrap();
    presentation.frame(&live);
    presentation.hold();
    assert!(presentation.stale());
    assert!(Arc::ptr_eq(
        &presentation.frame(&lost("boot", 3)).unwrap(),
        &first
    ));

    // The reconnected daemon's snapshot alone does not replace the picture.
    presentation.resume();
    let mut handshaking = connected("boot", 9);
    handshaking.surface = None;
    assert!(Arc::ptr_eq(
        &presentation.frame(&handshaking).unwrap(),
        &first
    ));
    assert!(presentation.stale());

    let next = connected("boot", 9);
    let replacement = next.surface.clone().unwrap();
    assert!(Arc::ptr_eq(
        &presentation.frame(&next).unwrap(),
        &replacement
    ));
    assert!(!presentation.stale());
}

#[test]
fn a_held_frame_goes_when_the_daemon_restarted_or_the_window_clears_it() {
    let mut presentation = Presentation::default();
    presentation.frame(&connected("boot", 1));
    presentation.hold();
    let mut rebooted = connected("other-boot", 1);
    rebooted.surface = None;
    assert!(presentation.frame(&rebooted).is_none());
    assert!(!presentation.stale());

    presentation.frame(&connected("boot", 1));
    presentation.hold();
    presentation.clear();
    assert!(!presentation.stale());
    assert!(presentation.frame(&lost("boot", 1)).is_none());
}

#[test]
fn holding_nothing_is_not_stale() {
    let mut presentation = Presentation::default();
    presentation.hold();
    assert!(!presentation.stale());
    assert!(presentation.frame(&lost("boot", 1)).is_none());
}

#[test]
fn while_held_even_a_ready_frame_is_the_lost_connections() {
    let mut presentation = Presentation::default();
    let live = connected("boot", 3);
    presentation.frame(&live);
    // The handle stopped before its disconnect state arrived: `live` still
    // holds the lost connection's ready frame, and that is no current picture.
    presentation.hold();
    assert!(presentation.frame(&live).is_some());
    assert!(presentation.stale());
    // Nor is a frame the lost connection delivered late.
    let late = connected("boot", 4);
    let shown = late.surface.clone().unwrap();
    assert!(Arc::ptr_eq(&presentation.frame(&late).unwrap(), &shown));
    assert!(presentation.stale());

    // Once the endpoint has a connection again, its first frame is current.
    presentation.resume();
    let mut waiting = connected("boot", 5);
    waiting.surface = None;
    presentation.frame(&waiting);
    assert!(
        presentation.stale(),
        "stale until the replacement frame lands"
    );
    presentation.frame(&connected("boot", 5));
    assert!(!presentation.stale());
}
