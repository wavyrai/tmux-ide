#![allow(clippy::unwrap_used)]
use super::*;
fn scope() -> Scope {
    Scope {
        pane: "pane".into(),
        lifetime: Lifetime {
            generation: "generation".into(),
            incarnation: "pane:1".into(),
        },
        presentation_epoch: 1,
    }
}
#[test]
fn focus_loss_cancels_only_undispatched_admission_and_keeps_ack_correlation() {
    let scope = scope();
    let mut scheduler = Scheduler::new(scope.clone());
    for sequence in 1..=8 {
        let Admission::Ready(dispatch) = scheduler
            .admit(&scope, Work::Input(Input::Text("a".into())))
            .unwrap()
        else {
            panic!()
        };
        scheduler
            .bind_input(dispatch.ticket, "pane", sequence)
            .unwrap();
    }
    assert!(matches!(
        scheduler
            .admit(&scope, Work::Barrier(Control::Paste("paste".into())))
            .unwrap(),
        Admission::Queued(_)
    ));
    let mut owner = InputOwner {
        scheduler: Some(scheduler),
        ..Default::default()
    };
    assert!(owner.waiting() && owner.busy());
    owner.focus_loss();
    assert!(!owner.waiting());
    for sequence in 1..=8 {
        let completion = herdr_client::tmux_control::InputCompletion {
            pane: "pane".into(),
            sequence,
            result: InputResult::Ok,
        };
        let update = owner.scheduler().unwrap().complete_input(&completion);
        assert!(update.next.is_none());
    }
    assert!(!owner.busy());
    assert!(!owner.scheduler().unwrap().retired());
}
#[test]
fn focus_loss_marks_dispatched_paste_suffix_cancelled_without_forgetting_ack() {
    let mut owner = InputOwner {
        active: Some(Active::Paste {
            ticket: Ticket(1),
            scope: scope(),
            sequence: 7,
            cancelled: false,
        }),
        ..Default::default()
    };
    owner.focus_loss();
    assert!(matches!(
        owner.active,
        Some(Active::Paste {
            sequence: 7,
            cancelled: true,
            ..
        })
    ));
}
#[test]
fn exact_mouse_enum_mapping_preserves_modifiers_and_geometry() {
    let event = mouse_event(pointer::Command::Event {
        action: pointer::Action::Drag,
        gesture: 42,
        row: 4,
        col: 7,
        button: Some(2),
        shift: false,
        alt: true,
        control: true,
        protocol: decode::MouseProtocol::Any,
        encoding: decode::MouseEncoding::Sgr,
        cols: 80,
        rows: 24,
    });
    let PointerEvent::Report(report) = event else {
        panic!()
    };
    assert_eq!(report.action, tmux_pointer::Action::Drag);
    assert_eq!(report.gesture, 42);
    assert_eq!(
        (report.row, report.col, report.cols, report.rows),
        (4, 7, 80, 24)
    );
    assert!(report.modifiers.alt && report.modifiers.control);
    assert_eq!(report.protocol, MouseProtocol::Any);
    assert_eq!(report.encoding, MouseEncoding::Sgr);
}

#[test]
fn transient_pointer_mode_or_preview_change_cancels_held_release() {
    let canonical = tmux_pointer::Scope {
        generation: "generation".into(),
        incarnation: "pane:1".into(),
        presentation_epoch: 1,
        cols: 80,
        rows: 24,
        protocol: Some(MouseProtocol::Any),
        encoding: Some(MouseEncoding::Sgr),
        alternate_screen: false,
    };
    let report = |action| {
        PointerEvent::Report(tmux_pointer::Report {
            action,
            gesture: 1,
            row: 0,
            col: 0,
            button: Some(0),
            modifiers: tmux_pointer::Modifiers::default(),
            cols: 80,
            rows: 24,
            protocol: MouseProtocol::Any,
            encoding: MouseEncoding::Sgr,
        })
    };
    for mode_change in [false, true] {
        let mut owner = InputOwner::default();
        assert!(matches!(
            owner
                .mouse
                .route(&canonical, report(tmux_pointer::Action::Down)),
            PointerDecision::Input(_)
        ));
        if mode_change {
            let mut changed = canonical.clone();
            changed.alternate_screen = true;
            owner.observe_pointer(Some(changed), true);
        } else {
            owner.observe_pointer(Some(canonical.clone()), false);
        }
        owner.observe_pointer(Some(canonical.clone()), true);
        assert!(matches!(
            owner
                .mouse
                .route(&canonical, report(tmux_pointer::Action::Up)),
            PointerDecision::Ignore
        ));
    }
    let mut owner = InputOwner::default();
    owner
        .mouse
        .route(&canonical, report(tmux_pointer::Action::Down));
    owner.observe_pointer(Some(canonical.clone()), true);
    assert!(matches!(
        owner
            .mouse
            .route(&canonical, report(tmux_pointer::Action::Up)),
        PointerDecision::Input(_)
    ));
}

#[test]
fn unsupported_bytes_barrier_can_finish_without_sequence_or_retirement() {
    let mut scheduler = Scheduler::new(scope());
    let Admission::Ready(dispatch) = scheduler
        .admit(&scope(), Work::Barrier(Control::Bytes("00ff80".into())))
        .unwrap()
    else {
        panic!()
    };
    scheduler.complete_barrier(dispatch.ticket, true).unwrap();
    assert!(scheduler.idle());
    assert!(!scheduler.retired());
    assert!(matches!(
        scheduler
            .admit(&scope(), Work::Input(Input::Text("next".into())))
            .unwrap(),
        Admission::Ready(_)
    ));
}
