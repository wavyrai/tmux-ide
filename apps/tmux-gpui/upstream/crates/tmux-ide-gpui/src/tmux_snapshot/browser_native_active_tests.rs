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
