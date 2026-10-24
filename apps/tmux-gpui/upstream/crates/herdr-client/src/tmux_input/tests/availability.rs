use super::*;

#[test]
fn resize_gap_settles_acks_but_retains_unsent_input_until_ready() {
    let mut s = Scheduler::new(scope());
    fill(&mut s, 8);
    let Admission::Queued(ticket) = s.admit(&scope(), text()).unwrap() else {
        panic!()
    };
    s.set_dispatch_enabled(false);
    for sequence in 1..=8 {
        assert!(
            s.complete_input(&ack(sequence, InputResult::Ok))
                .next
                .is_none()
        );
    }
    assert_eq!(s.pending(), 0);
    assert!(s.waiting());
    assert!(s.take_ready().is_none());
    s.set_dispatch_enabled(true);
    assert_eq!(s.take_ready().unwrap().ticket, ticket);
    assert!(s.take_ready().is_none());
    s.bind_input(ticket, "pane.one", 9).unwrap();
    s.complete_input(&ack(9, InputResult::Ok));
    assert!(s.idle());
}

#[test]
fn focus_cancellation_and_authority_loss_never_resume_queued_text() {
    for lost_authority in [false, true] {
        let mut s = Scheduler::new(scope());
        fill(&mut s, 8);
        s.admit(&scope(), text()).unwrap();
        s.set_dispatch_enabled(false);
        if lost_authority {
            s.complete_input(&ack(1, InputResult::AuthorityLost));
        } else {
            assert!(s.cancel_waiting().is_some());
        }
        s.set_dispatch_enabled(true);
        assert!(s.take_ready().is_none());
    }
}
