use super::*;
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
