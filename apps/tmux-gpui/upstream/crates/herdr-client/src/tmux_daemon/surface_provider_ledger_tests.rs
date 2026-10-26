#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
fn start(id: Uuid, generation: Uuid) -> Event {
    Event::parse(
        json!({"type":"start","connection":id,"panes":["pane.editor"],
        "receiver":{"type":"terminal-surface-receiver","version":1,"generation":generation,
        "connectionNonce":Uuid::new_v4(),"challenge":Uuid::new_v4(),"pid":1,"slot":0,
        "auditToken":[1,1,1,1,1,1,1,1]}})
        .to_string()
        .as_bytes(),
        generation,
    )
    .unwrap()
}
fn offer(connection: Uuid, generation: Uuid, sequence: u64, bytes: usize) -> Submission {
    Submission {
        connection,
        generation: generation.to_string(),
        pane: "pane.editor".into(),
        sequence,
        allocation_bytes: bytes,
        encoded: String::new(),
    }
}
#[test]
fn only_accepted_original_connection_can_retire_once() {
    let mut ledger = Ledger::default();
    let generation = Uuid::new_v4();
    let id = Uuid::new_v4();
    let other = Uuid::new_v4();
    ledger.apply(&mut start(id, generation)).unwrap();
    ledger.apply(&mut start(other, generation)).unwrap();
    ledger
        .submit(&offer(id, generation, 1, 1024), generation)
        .unwrap();
    assert!(
        ledger
            .apply(&mut Event::Retired {
                connection: id,
                sequence: 1
            })
            .is_err()
    );
    assert!(
        ledger
            .apply(&mut Event::Offered {
                connection: other,
                sequence: 1,
                accepted: true
            })
            .is_err()
    );
    ledger
        .apply(&mut Event::Offered {
            connection: id,
            sequence: 1,
            accepted: true,
        })
        .unwrap();
    assert!(
        ledger
            .apply(&mut Event::Offered {
                connection: id,
                sequence: 1,
                accepted: true
            })
            .is_err()
    );
    ledger
        .apply(&mut Event::Fallback { connection: id })
        .unwrap();
    assert!(
        ledger
            .submit(&offer(id, generation, 2, 1024), generation)
            .is_err()
    );
    ledger
        .apply(&mut Event::Retired {
            connection: id,
            sequence: 1,
        })
        .unwrap();
    assert!(
        ledger
            .apply(&mut Event::Retired {
                connection: id,
                sequence: 1
            })
            .is_err()
    );
    assert_eq!((ledger.frames, ledger.bytes), (0, 0));
}
#[test]
fn late_acceptance_does_not_grant_transfer_after_fallback() {
    let mut ledger = Ledger::default();
    let generation = Uuid::new_v4();
    let id = Uuid::new_v4();
    ledger.apply(&mut start(id, generation)).unwrap();
    ledger
        .submit(&offer(id, generation, 1, 1024), generation)
        .unwrap();
    ledger
        .apply(&mut Event::Fallback { connection: id })
        .unwrap();
    let mut event = Event::Offered {
        connection: id,
        sequence: 1,
        accepted: true,
    };
    ledger.apply(&mut event).unwrap();
    assert!(matches!(
        event,
        Event::Offered {
            accepted: false,
            ..
        }
    ));
    assert_eq!(ledger.bytes, 1024);
    ledger.apply(&mut Event::Close { connection: id }).unwrap();
    assert_eq!((ledger.frames, ledger.bytes), (0, 0));
}
#[test]
fn pending_offers_are_bounded_and_rejection_releases_accounting() {
    let mut ledger = Ledger::default();
    let generation = Uuid::new_v4();
    let id = Uuid::new_v4();
    ledger.apply(&mut start(id, generation)).unwrap();
    for seq in 1..=8 {
        ledger
            .submit(&offer(id, generation, seq, 8 * 1024 * 1024), generation)
            .unwrap();
    }
    assert!(
        ledger
            .submit(&offer(id, generation, 9, 1024), generation)
            .is_err()
    );
    ledger
        .apply(&mut Event::Offered {
            connection: id,
            sequence: 1,
            accepted: false,
        })
        .unwrap();
    ledger
        .submit(&offer(id, generation, 9, 1024), generation)
        .unwrap();
    assert!(
        ledger
            .submit(&offer(id, generation, 8, 1024), generation)
            .is_err()
    );
    ledger.apply(&mut Event::Close { connection: id }).unwrap();
    assert_eq!((ledger.frames, ledger.bytes), (0, 0));
}

#[test]
fn all_connections_share_frame_and_allocation_limits() {
    for (per_connection, bytes) in [(1, 64 * 1024 * 1024), (8, 1024)] {
        let mut ledger = Ledger::default();
        let generation = Uuid::new_v4();
        let ids: Vec<_> = (0..5).map(|_| Uuid::new_v4()).collect();
        for id in &ids {
            ledger.apply(&mut start(*id, generation)).unwrap();
        }
        for id in &ids[..4] {
            for sequence in 1..=per_connection {
                ledger
                    .submit(&offer(*id, generation, sequence, bytes), generation)
                    .unwrap();
            }
        }
        assert!(
            ledger
                .submit(&offer(ids[4], generation, 1, bytes), generation)
                .is_err()
        );
        ledger
            .apply(&mut Event::Close { connection: ids[0] })
            .unwrap();
        ledger
            .submit(&offer(ids[4], generation, 1, bytes), generation)
            .unwrap();
    }
}

#[test]
fn unobserved_or_mismatched_demand_never_suppresses_kitty() {
    let mut ledger = Ledger::default();
    assert!(ledger.kitty_required("pane.one"));
    assert!(
        ledger
            .apply(&mut Event::KittyDemand {
                panes: vec!["pane.one".into()],
                required: vec![]
            })
            .is_err()
    );
    assert!(
        ledger
            .watch(vec!["pane.one".into(), "pane.two".into()])
            .unwrap()
    );
    assert!(
        !ledger
            .watch(vec!["pane.two".into(), "pane.one".into()])
            .unwrap()
    );
    assert!(ledger.watch(vec!["pane.other".into()]).is_err());
    assert!(ledger.kitty_required("pane.one"));
    assert!(
        ledger
            .apply(&mut Event::KittyDemand {
                panes: vec!["pane.one".into()],
                required: vec![]
            })
            .is_err()
    );
    ledger
        .apply(&mut Event::KittyDemand {
            panes: vec!["pane.one".into(), "pane.two".into()],
            required: vec!["pane.one".into()],
        })
        .unwrap();
    assert!(ledger.kitty_required("pane.one"));
    assert!(!ledger.kitty_required("pane.two"));
    assert!(ledger.kitty_required("pane.unknown"));
    ledger
        .apply(&mut Event::KittyDemand {
            panes: vec!["pane.one".into(), "pane.two".into()],
            required: vec![],
        })
        .unwrap();
    assert!(!ledger.kitty_required("pane.one"));
}
