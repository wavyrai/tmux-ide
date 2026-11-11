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
