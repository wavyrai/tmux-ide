use super::*;

#[test]
fn interrupted_mutations_refresh_only_submitted_structural_actions() {
    for sent in [false, true] {
        for action in [
            PaneAction::Close,
            PaneAction::Split(Direction::Right),
            PaneAction::Rename("name".into()),
        ] {
            let structural = action.structural();
            let mut state = ActionState {
                pending: Some(Pending {
                    pane: "pane".into(),
                    lifetime: Lifetime {
                        generation: "gen".into(),
                        incarnation: "pane:1".into(),
                    },
                    operation: "op".into(),
                    action,
                    deadline: 10,
                    sent,
                    geometry_requested: false,
                }),
            };
            let completion = state
                .interrupted()
                .unwrap_or_else(|| panic!("pending completion"));
            assert_eq!(completion.outcome, ActionOutcome::TimedOut);
            assert_eq!(completion.reissue, sent && structural);
            assert!(!state.busy());
            assert!(state.interrupted().is_none());
        }
    }
}
