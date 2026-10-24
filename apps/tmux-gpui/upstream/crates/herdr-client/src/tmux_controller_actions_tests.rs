use super::*;
#[test]
fn pane_intents_preserve_required_geometry_and_structural_scope() {
    for action in [
        PaneAction::Rename("name".into()),
        PaneAction::Zoom(Zoom::Toggle),
        PaneAction::Split(Direction::Right),
        PaneAction::Close,
        PaneAction::Resize {
            axis: Axis::Cols,
            cells: 80,
        },
    ] {
        let intent =
            serde_json::to_value(action.intent("pane")).unwrap_or_else(|_| panic!("serializable"));
        assert_eq!(intent["semanticPaneId"], "pane");
        assert_eq!(action.geometry(), !matches!(action, PaneAction::Rename(_)));
        assert_eq!(
            action.structural(),
            matches!(action, PaneAction::Split(_) | PaneAction::Close)
        );
    }
}
#[test]
fn waiting_cancellation_and_sent_completion_are_distinct() {
    let pending = |sent| Pending {
        pane: "pane".into(),
        lifetime: Lifetime {
            generation: "gen".into(),
            incarnation: "pane:1".into(),
        },
        operation: "op".into(),
        action: PaneAction::Split(Direction::Down),
        deadline: 10,
        sent,
        geometry_requested: false,
    };
    let mut state = ActionState {
        pending: Some(pending(false)),
    };
    assert!(state.waiting());
    assert!(matches!(
        state.cancel_waiting(),
        Some(ActionCompletion {
            outcome: ActionOutcome::Cancelled,
            reissue: false,
            ..
        })
    ));
    assert!(!state.busy());
    state.pending = Some(pending(true));
    assert!(state.cancel_waiting().is_none());
    assert!(state.busy());
    assert!(matches!(
        state.finish(ActionOutcome::Applied),
        Some(ActionCompletion { reissue: true, .. })
    ));
    assert!(!state.busy());
}

#[path = "tmux_controller_actions_tests/interruption.rs"]
mod interruption;
