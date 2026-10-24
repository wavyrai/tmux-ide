#![allow(clippy::unwrap_used)]
use super::*;
fn scope() -> Scope {
    Scope {
        pane: "pane.one".into(),
        lifetime: Lifetime {
            generation: "12d14eac-0000-4000-8000-000000000001".into(),
            incarnation: "birth".into(),
        },
        presentation_epoch: 0,
    }
}
fn text() -> Work<&'static str> {
    Work::Input(Input::Text("x".into()))
}
fn ready(admission: Admission<&'static str>) -> Dispatch<&'static str> {
    match admission {
        Admission::Ready(d) => d,
        _ => panic!("expected dispatch"),
    }
}
fn ack(seq: u32, result: InputResult) -> InputCompletion {
    InputCompletion {
        pane: "pane.one".into(),
        sequence: seq,
        result,
    }
}
fn fill(s: &mut Scheduler<&'static str>, count: u32) -> Vec<Ticket> {
    (1..=count)
        .map(|seq| {
            let dispatch = ready(s.admit(&scope(), text()).unwrap());
            s.bind_input(dispatch.ticket, "pane.one", seq).unwrap();
            dispatch.ticket
        })
        .collect()
}
#[test]
fn eight_pipeline_and_one_waiting_no_bypass() {
    let mut s = Scheduler::new(scope());
    let tickets = fill(&mut s, 8);
    let Admission::Queued(ninth) = s.admit(&scope(), text()).unwrap() else {
        panic!()
    };
    assert_eq!(s.pending(), 8);
    let rejected = s
        .admit(&scope(), Work::Input(Input::Key("Enter".into())))
        .unwrap_err();
    assert_eq!(rejected.reason, Error::Busy);
    assert!(matches!(rejected.work, Work::Input(Input::Key(_))));
    let update = s.complete_input(&ack(4, InputResult::Ok));
    assert_eq!(update.finished, vec![(tickets[3], Completion::Ok)]);
    assert_eq!(update.next.unwrap().ticket, ninth);
    assert_eq!(s.pending(), 8);
}
#[test]
fn enter_waits_for_every_ack_and_blocks_following_printable_input() {
    let mut s = Scheduler::new(scope());
    fill(&mut s, 3);
    let Admission::Queued(enter) = s
        .admit(&scope(), Work::Input(Input::Key("Enter".into())))
        .unwrap()
    else {
        panic!()
    };
    assert!(s.complete_input(&ack(3, InputResult::Ok)).next.is_none());
    assert!(s.complete_input(&ack(1, InputResult::Ok)).next.is_none());
    assert_eq!(
        s.complete_input(&ack(2, InputResult::Ok))
            .next
            .unwrap()
            .ticket,
        enter
    );
    s.bind_input(enter, "pane.one", 4).unwrap();
    let Admission::Queued(text) = s.admit(&scope(), text()).unwrap() else {
        panic!()
    };
    assert_eq!(
        s.complete_input(&ack(4, InputResult::Ok))
            .next
            .unwrap()
            .ticket,
        text
    );
}
#[test]
fn paste_mouse_presence_and_control_are_exclusive_barriers() {
    for control in ["paste", "mouse", "wheel", "presence", "semantic"] {
        let mut s = Scheduler::new(scope());
        fill(&mut s, 1);
        let Admission::Queued(barrier) = s.admit(&scope(), Work::Barrier(control)).unwrap() else {
            panic!()
        };
        assert_eq!(
            s.complete_input(&ack(1, InputResult::Ok))
                .next
                .unwrap()
                .ticket,
            barrier
        );
        let Admission::Queued(after) = s.admit(&scope(), text()).unwrap() else {
            panic!()
        };
        assert_eq!(
            s.complete_barrier(barrier, true)
                .unwrap()
                .next
                .unwrap()
                .ticket,
            after
        );
    }
}
#[test]
fn uncertain_ack_retires_pending_and_waiting_without_suffix() {
    for failure in [
        InputResult::Timeout,
        InputResult::AuthorityLost,
        InputResult::Retired,
    ] {
        let mut s = Scheduler::new(scope());
        fill(&mut s, 8);
        s.admit(&scope(), Work::Barrier("paste")).unwrap();
        let update = s.complete_input(&ack(2, failure));
        assert_eq!(update.finished.len(), 9);
        assert!(update.next.is_none());
        assert!(s.retired());
        assert_eq!(
            s.admit(&scope(), text()).unwrap_err().reason,
            Error::Retired
        );
        assert!(
            s.complete_input(&ack(1, InputResult::Ok))
                .finished
                .is_empty()
        );
    }
}
#[test]
fn scope_changes_only_when_idle_and_never_replay_old_queued_work() {
    let mut s = Scheduler::new(scope());
    let mut next = scope();
    next.presentation_epoch = 1;
    s.change_scope(next.clone()).unwrap();
    let d = ready(s.admit(&next, text()).unwrap());
    s.bind_input(d.ticket, "pane.one", 1).unwrap();
    s.admit(&next, Work::Barrier("paste")).unwrap();
    next.pane = "pane.two".into();
    assert_eq!(s.change_scope(next), Err(Error::ScopeChanged));
    let update = s.retire();
    assert_eq!(update.finished.len(), 2);
    assert!(update.next.is_none());
}
#[test]
fn exact_correlation_out_of_order_duplicate_and_invalid_binding() {
    let mut s = Scheduler::new(scope());
    let tickets = fill(&mut s, 2);
    assert!(
        s.complete_input(&ack(99, InputResult::Ok))
            .finished
            .is_empty()
    );
    assert_eq!(
        s.complete_input(&ack(2, InputResult::Ok)).finished,
        vec![(tickets[1], Completion::Ok)]
    );
    assert!(
        s.complete_input(&ack(2, InputResult::Ok))
            .finished
            .is_empty()
    );
    assert_eq!(
        s.bind_input(tickets[0], "pane.two", 3),
        Err(Error::Correlation)
    );
    assert!(s.retired());
    assert_eq!(s.retire().finished, vec![(tickets[0], Completion::Retired)]);
}
#[test]
fn pipeline_classifier_matches_existing_printable_and_unmodified_key_rule() {
    for data in ["hi", "é🦀", "\u{200b}"] {
        assert!(pipeline::<()>(&Work::Input(Input::Text(data.into()))));
    }
    for data in ["\0", "\x1b", "\t", "\r", "\n", "\u{85}"] {
        assert!(!pipeline::<()>(&Work::Input(Input::Text(data.into()))));
    }
    for key in [
        "BSpace", "DC", "Left", "Right", "Up", "Down", "Home", "End", "NPage", "PPage", "PgUp",
        "PgDn", "Space",
    ] {
        assert!(pipeline::<()>(&Work::Input(Input::Key(key.into()))));
    }
    for key in ["Enter", "Tab", "Escape", "C-a", "M-Left", "S-Up", "F1"] {
        assert!(!pipeline::<()>(&Work::Input(Input::Key(key.into()))));
    }
}
#[test]
fn failed_barrier_retires_waiting_and_failed_enqueue_can_retire_reservation() {
    let mut s = Scheduler::new(scope());
    let barrier = ready(s.admit(&scope(), Work::Barrier("paste")).unwrap());
    s.admit(&scope(), text()).unwrap();
    assert_eq!(
        s.complete_barrier(barrier.ticket, false)
            .unwrap()
            .finished
            .len(),
        2
    );
    let mut s = Scheduler::new(scope());
    let reservation = ready(s.admit(&scope(), text()).unwrap());
    assert_eq!(
        s.retire().finished,
        vec![(reservation.ticket, Completion::Retired)]
    );
}

#[test]
fn oversized_input_rejected_before_reserving_or_queueing() {
    let mut s: Scheduler<()> = Scheduler::new(scope());
    for input in [
        Input::Text("x".repeat(1025)),
        Input::Text("🦀".repeat(513)),
        Input::Text("\0".into()),
        Input::Key("x".repeat(65)),
    ] {
        assert_eq!(
            s.admit(&scope(), Work::Input(input)).unwrap_err().reason,
            Error::InvalidInput
        );
        assert!(s.idle());
        assert!(!s.retired());
    }
}

#[test]
fn cancel_waiting_drops_only_unsent_suffix_and_preserves_ack_correlations() {
    let mut s = Scheduler::new(scope());
    let tickets = fill(&mut s, 8);
    let Admission::Queued(waiting) = s.admit(&scope(), text()).unwrap() else {
        panic!()
    };
    assert_eq!(s.cancel_waiting(), Some(waiting));
    assert_eq!(s.cancel_waiting(), None);
    assert_eq!(s.pending(), 8);
    for seq in (1..=8).rev() {
        let update = s.complete_input(&ack(seq, InputResult::Ok));
        assert_eq!(
            update.finished,
            vec![(tickets[(seq - 1) as usize], Completion::Ok)]
        );
        assert!(update.next.is_none());
    }
    assert!(s.idle());
    assert!(!s.retired());
}
#[test]
fn cancel_waiting_does_not_cancel_dispatched_exclusive_barrier() {
    let mut s = Scheduler::new(scope());
    let barrier = ready(s.admit(&scope(), Work::Barrier("paste")).unwrap());
    let Admission::Queued(waiting) = s.admit(&scope(), text()).unwrap() else {
        panic!()
    };
    assert_eq!(s.cancel_waiting(), Some(waiting));
    let update = s.complete_barrier(barrier.ticket, true).unwrap();
    assert_eq!(update.finished, vec![(barrier.ticket, Completion::Ok)]);
    assert!(update.next.is_none());
}

#[test]
fn byte_input_is_bounded_and_always_an_exclusive_barrier() {
    assert!(!pipeline::<()>(&Work::Input(Input::Bytes("61".into()))));
    let mut scheduler = Scheduler::<()>::new(scope());
    assert!(
        scheduler
            .admit(&scope(), Work::Input(Input::Bytes("00".repeat(1025))))
            .is_err()
    );
    assert!(
        scheduler
            .admit(&scope(), Work::Input(Input::Bytes("ff8000".into())))
            .is_ok()
    );
}

#[path = "tests/availability.rs"]
mod availability;
