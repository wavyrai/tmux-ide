#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn backpressure_cannot_erase_background_before_reactivation() {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let mut state = Presence::new(true);
    state.flush(&tx);
    state.set_active(false);
    state.flush(&tx); // Queue is still full.
    state.set_active(true);
    assert!(!state.ready());
    assert!(matches!(
        rx.recv().unwrap(),
        Command::Presence { active: true, .. }
    ));
    state.flush(&tx);
    assert!(matches!(
        rx.recv().unwrap(),
        Command::Presence { active: false, .. }
    ));
    assert!(!state.ready());
    state.flush(&tx);
    assert!(matches!(
        rx.recv().unwrap(),
        Command::Presence { active: true, .. }
    ));
    assert!(!state.ready());
    state.acknowledge(1);
    assert!(!state.ready());
    state.acknowledge(3);
    assert!(state.ready());
    state.flush(&tx);
    assert!(rx.try_recv().is_err());
}
