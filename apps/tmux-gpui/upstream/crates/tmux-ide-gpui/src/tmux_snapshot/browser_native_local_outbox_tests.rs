#![allow(clippy::unwrap_used)]
use super::*;

fn catalog(status: &str) -> Incoming {
    Incoming::Catalog(Box::new(State {
        status: status.into(),
        ..State::default()
    }))
}
fn status(event: Incoming) -> String {
    match event {
        Incoming::Catalog(state) => state.status,
        _ => panic!("expected a catalog snapshot"),
    }
}

#[test]
fn a_full_queue_waits_in_order_and_keeps_only_the_latest_snapshot() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let mut events = Events::from(sender);
    events.emit(catalog("first")).unwrap();
    events.emit(catalog("waiting")).unwrap();
    events.emit(Incoming::Closed).unwrap();
    events.emit(catalog("older")).unwrap();
    events.emit(catalog("latest")).unwrap();
    assert!(events.pending());
    assert_eq!(status(receiver.try_recv().unwrap()), "first");
    events.flush().unwrap();
    assert_eq!(status(receiver.try_recv().unwrap()), "waiting");
    events.flush().unwrap();
    assert!(matches!(receiver.try_recv().unwrap(), Incoming::Closed));
    events.flush().unwrap();
    assert_eq!(status(receiver.try_recv().unwrap()), "latest");
    events.flush().unwrap();
    assert!(!events.pending());
    assert!(receiver.try_recv().is_err());
}

#[test]
fn a_snapshot_never_jumps_over_a_discrete_event() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let mut events = Events::from(sender);
    events.emit(Incoming::Closed).unwrap();
    events.emit(catalog("before")).unwrap();
    events.emit(Incoming::Closed).unwrap();
    events.emit(catalog("after")).unwrap();
    let mut seen = Vec::new();
    for _ in 0..4 {
        seen.push(match receiver.try_recv().unwrap() {
            Incoming::Catalog(state) => state.status,
            _ => "event".into(),
        });
        events.flush().unwrap();
    }
    assert_eq!(seen, ["event", "before", "event", "after"]);
}

#[test]
fn only_a_gone_receiver_closes_the_catalog() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let mut events = Events::from(sender);
    for _ in 0..100 {
        events.emit(Incoming::Closed).unwrap();
    }
    drop(receiver);
    let error = events.emit(catalog("late")).unwrap_err();
    assert!(closed(&error));
    assert!(!closed(&Error::Invalid("native catalog worker failed")));
}

#[test]
fn a_stalled_receiver_counts_as_gone_past_the_bound() {
    let (sender, _receiver) = mpsc::sync_channel(1);
    let mut events = Events::from(sender);
    for _ in 0..=MAX_BACKLOG {
        events.emit(Incoming::Closed).unwrap();
    }
    assert!(closed(&events.emit(Incoming::Closed).unwrap_err()));
}
