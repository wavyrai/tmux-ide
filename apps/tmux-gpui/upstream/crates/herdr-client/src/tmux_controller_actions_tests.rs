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

/// The swap a pane drag sends encodes exactly as the daemon's own vector:
/// the selected pane is the source, the captured pane the target.
#[test]
fn swap_encodes_as_the_daemon_vector() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("tmux_control/tests/extra-intent-vectors.json"))
            .unwrap_or_else(|_| panic!("vectors"));
    let vector = vectors["vectors"]
        .as_array()
        .and_then(|v| {
            v.iter()
                .find(|v| v["command"]["intent"]["verb"] == "workspace.pane.swap")
        })
        .unwrap_or_else(|| panic!("swap vector"));
    let mut expected = vector["command"]["intent"].clone();
    if let Some(intent) = expected.as_object_mut() {
        intent.remove("workspaceName");
    }
    let action = PaneAction::Swap {
        target: "pane.two".into(),
        lifetime: Lifetime {
            generation: "gen".into(),
            incarnation: "pane.two:1".into(),
        },
    };
    let intent =
        serde_json::to_value(action.intent("pane.one")).unwrap_or_else(|_| panic!("intent"));
    assert_eq!(intent, expected);
    assert!(action.geometry(), "a swap moves panes: it needs geometry");
    assert!(
        !action.structural(),
        "a swap keeps both panes and their lifetimes"
    );
}

#[path = "tmux_controller_actions_tests/interruption.rs"]
mod interruption;
