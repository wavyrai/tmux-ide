use super::*;
use herdr_client::tmux_controller::InputReport;
#[test]
fn busy_actions_clear_without_another_presentation_apply() {
    let mut state = State::default();
    state
        .input_targets
        .push(crate::tmux_snapshot::pending_input::Target {
            id: "pane".into(),
            token: "token".into(),
        });
    publish_pane_actions(&mut state, "pane", false, 0, false);
    assert!(state.pane_actions.is_some());
    publish_pane_actions(&mut state, "pane", false, 0, true);
    assert!(state.pane_actions.is_none());
    publish_pane_actions(&mut state, "pane", true, 0, false);
    assert!(state.pane_actions.as_ref().is_some_and(|a| a.zoomed));
    state.input_targets.clear();
    publish_pane_actions(&mut state, "pane", true, 0, false);
    assert!(state.pane_actions.is_none());
}
/// Card 0's measurement line: elapsed time, total and per-pane bytes, one line.
#[test]
fn the_input_report_line_names_time_and_bytes_per_pane() {
    let report = InputReport {
        elapsed: Duration::from_millis(842),
        received: [("%1".to_owned(), 1200), ("%7".to_owned(), 30)].into(),
    };
    assert_eq!(
        input_report_line(&report),
        "tmux-preview: stream input ready after 842 ms, 1230 bytes over 2 panes [%1=1200 %7=30]"
    );
}
fn wheel(lines: i16, row: u16, shift: bool) -> Command {
    Command::Input {
        input_target: None,
        request: 4,
        id: "pane".into(),
        input: crate::tmux_snapshot::keys::Input::Wheel {
            lines,
            row,
            col: 3,
            shift,
            alt: false,
            control: false,
        },
    }
}
fn lines(command: &Command) -> i16 {
    match command {
        Command::Input {
            input: crate::tmux_snapshot::keys::Input::Wheel { lines, .. },
            ..
        } => *lines,
        _ => panic!("not a wheel"),
    }
}
/// A trackpad sends a wheel event per frame. Over SSH each one waits a round
/// trip for its ACK, so the queued ones merge into one with their lines summed.
#[test]
fn queued_wheel_steps_merge_into_one() {
    let mut pending = std::collections::VecDeque::new();
    for _ in 0..30 {
        queue(&mut pending, wheel(-2, 5, false));
    }
    assert_eq!(pending.len(), 1);
    assert_eq!(lines(&pending[0]), -60);
}
#[test]
fn wheel_steps_merge_only_when_nothing_differs_but_the_lines() {
    let mut pending = std::collections::VecDeque::new();
    queue(&mut pending, wheel(-2, 5, false));
    // Another direction, row or modifier stays its own step, in order.
    queue(&mut pending, wheel(2, 5, false));
    queue(&mut pending, wheel(2, 6, false));
    queue(&mut pending, wheel(2, 6, true));
    assert_eq!(pending.len(), 4);
    // Never past the ±128 lines one wheel step may carry.
    queue(&mut pending, wheel(100, 6, true));
    queue(&mut pending, wheel(100, 6, true));
    assert_eq!(pending.len(), 5);
    assert_eq!(lines(&pending[3]), 102);
    assert_eq!(lines(&pending[4]), 100);
    // A command in between is never jumped over.
    let mut pending = std::collections::VecDeque::new();
    queue(&mut pending, wheel(-1, 5, false));
    queue(
        &mut pending,
        Command::Input {
            input_target: None,
            request: 4,
            id: "pane".into(),
            input: crate::tmux_snapshot::keys::Input::Text("a".into()),
        },
    );
    queue(&mut pending, wheel(-1, 5, false));
    assert_eq!(pending.len(), 3);
}
fn queue(pending: &mut std::collections::VecDeque<Command>, command: Command) {
    assert!(push(pending, command, 64));
}
/// A full queue refuses a new command but still takes a wheel step that merges.
#[test]
fn a_full_queue_still_takes_a_merging_wheel_step() {
    let mut pending = std::collections::VecDeque::new();
    assert!(push(&mut pending, wheel(-1, 5, false), 1));
    assert!(push(&mut pending, wheel(-1, 5, false), 1));
    assert!(!push(&mut pending, wheel(1, 5, false), 1));
    assert_eq!(pending.len(), 1);
    assert_eq!(lines(&pending[0]), -2);
}
fn text(data: &str) -> Command {
    Command::Input {
        input_target: None,
        request: 4,
        id: "pane".into(),
        input: crate::tmux_snapshot::keys::Input::Text(data.into()),
    }
}
fn text_of(command: &Command) -> &str {
    match command {
        Command::Input {
            input: crate::tmux_snapshot::keys::Input::Text(data),
            ..
        } => data,
        _ => panic!("not text"),
    }
}
/// The first key is queued alone and admitted on the next turn. Keys typed
/// while it waits join one input, so a burst costs one frame, one ACK and
/// one echo delivery instead of one per key; order within it is kept.
#[test]
fn text_typed_behind_a_queued_key_joins_it_in_order() {
    let mut pending = std::collections::VecDeque::new();
    queue(&mut pending, text("l"));
    assert_eq!(text_of(&pending[0]), "l");
    for key in ["s", " ", "-", "l", "a"] {
        queue(&mut pending, text(key));
    }
    assert_eq!(pending.len(), 1);
    assert_eq!(text_of(&pending[0]), "ls -la");
}
#[test]
fn text_never_joins_across_another_command_or_past_one_input() {
    let mut pending = std::collections::VecDeque::new();
    queue(&mut pending, text("a"));
    queue(
        &mut pending,
        Command::Input {
            input_target: None,
            request: 4,
            id: "pane".into(),
            input: crate::tmux_snapshot::keys::Input::Key("Enter".into()),
        },
    );
    queue(&mut pending, text("b"));
    assert_eq!(pending.len(), 3);
    // Another pane or request stays its own input.
    let mut other = text("c");
    if let Command::Input { id, .. } = &mut other {
        *id = "other".into();
    }
    queue(&mut pending, other);
    assert_eq!(pending.len(), 4);
    // One input carries at most 1024 UTF-16 units.
    let mut pending = std::collections::VecDeque::new();
    queue(&mut pending, text(&"x".repeat(1020)));
    queue(&mut pending, text("12345"));
    assert_eq!(pending.len(), 2);
    assert_eq!(text_of(&pending[0]).len(), 1020);
}
/// A wheel step for another pane, another request or another input target is
/// never folded into the queued one: its lines would scroll the wrong pane or
/// outlive the request they were typed for.
#[test]
fn wheel_steps_never_merge_across_pane_request_or_target() {
    let retarget = |command: &mut Command, change: &str| {
        if let Command::Input {
            input_target,
            request,
            id,
            ..
        } = command
        {
            match change {
                "pane" => *id = "other".into(),
                "request" => *request = 5,
                _ => *input_target = Some("target".into()),
            }
        }
    };
    for change in ["pane", "request", "target"] {
        let mut pending = std::collections::VecDeque::new();
        queue(&mut pending, wheel(-2, 5, false));
        let mut next = wheel(-2, 5, false);
        retarget(&mut next, change);
        queue(&mut pending, next);
        assert_eq!(pending.len(), 2, "merged across a different {change}");
        assert_eq!(lines(&pending[0]), -2);
        assert_eq!(lines(&pending[1]), -2);
    }
}
/// The transport folds only the ticks at the front of its queue, for this
/// request's pane and no input target, into the scheduler's waiting step.
#[test]
fn queued_ticks_fold_into_the_waiting_wheel_step_only_from_the_front() {
    let mut owner = InputOwner::with_waiting_wheel_for_tests("pane");
    let mut pending: std::collections::VecDeque<Command> = [
        wheel(-1, 5, false),
        wheel(-1, 5, false),
        text("a"),
        wheel(-1, 5, false),
    ]
    .into();
    fold_into_waiting(&mut pending, &mut owner, 4);
    assert_eq!(owner.waiting_wheel_lines_for_tests(), Some(-3));
    // The key stops it: the tick behind the key stays behind the key.
    assert_eq!(pending.len(), 2);
    assert_eq!(text_of(&pending[0]), "a");
    // Another request, pane or input target is never folded.
    for change in ["request", "pane", "target"] {
        let mut owner = InputOwner::with_waiting_wheel_for_tests("pane");
        let mut tick = wheel(-1, 5, false);
        if let Command::Input {
            input_target,
            request,
            id,
            ..
        } = &mut tick
        {
            match change {
                "request" => *request = 5,
                "pane" => *id = "other".into(),
                _ => *input_target = Some("target".into()),
            }
        }
        let mut pending: std::collections::VecDeque<Command> = [tick].into();
        fold_into_waiting(&mut pending, &mut owner, 4);
        assert_eq!(pending.len(), 1, "folded across a different {change}");
        assert_eq!(owner.waiting_wheel_lines_for_tests(), Some(-1));
    }
}
/// Text for another input target (an editor or browser field) or from an
/// earlier request never joins a queued key: it would be sent to the wrong
/// place or outlive the request it was typed for.
#[test]
fn text_never_joins_across_input_target_or_request() {
    for change in ["target", "request"] {
        let mut pending = std::collections::VecDeque::new();
        queue(&mut pending, text("a"));
        let mut next = text("b");
        if let Command::Input {
            input_target,
            request,
            ..
        } = &mut next
        {
            if change == "target" {
                *input_target = Some("target".into());
            } else {
                *request = 5;
            }
        }
        queue(&mut pending, next);
        assert_eq!(pending.len(), 2, "text joined across a different {change}");
        assert_eq!(text_of(&pending[0]), "a");
        assert_eq!(text_of(&pending[1]), "b");
    }
}
/// The fold keeps one step within ±128 lines: route_wheel ignores a step
/// outside it, so an over-fold would drop the whole scroll. A tick that
/// would cross the bound stays queued, as its own step.
#[test]
fn a_tick_that_would_pass_128_lines_stays_queued() {
    let mut owner = InputOwner::with_waiting_wheel_for_tests("pane");
    let mut pending: std::collections::VecDeque<Command> = [
        wheel(-120, 5, false),
        wheel(-8, 5, false),
        wheel(-1, 5, false),
    ]
    .into();
    fold_into_waiting(&mut pending, &mut owner, 4);
    // -1 (waiting) - 120 - 7 would be -128; -120 - 8 more is -129.
    assert_eq!(owner.waiting_wheel_lines_for_tests(), Some(-121));
    assert_eq!(pending.len(), 2);
    assert_eq!(lines(&pending[0]), -8);
}
