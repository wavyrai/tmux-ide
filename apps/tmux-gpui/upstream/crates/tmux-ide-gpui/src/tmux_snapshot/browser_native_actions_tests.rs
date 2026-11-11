use super::*;
#[test]
fn maps_semantic_actions_without_inventing_owner_authority() {
    let p = NativePresentation::new("scope", "workspace");
    assert!(matches!(
        adapt(pane_actions::Action::Close, &p),
        Ok(PaneAction::Close)
    ));
    assert!(matches!(
        adapt(
            pane_actions::Action::Zoom {
                desired: pane_actions::Zoom::Unzoomed
            },
            &p
        ),
        Ok(PaneAction::Zoom(Zoom::Unzoomed))
    ));
    assert!(matches!(
        adapt(
            pane_actions::Action::Split {
                direction: pane_actions::SplitDirection::Down
            },
            &p
        ),
        Ok(PaneAction::Split(Direction::Down))
    ));
    assert!(
        matches!(adapt(pane_actions::Action::Rename{name:"name".into()}, &p),Ok(PaneAction::Rename(name)) if name=="name")
    );
    assert!(matches!(
        adapt(pane_actions::Action::NewWindow, &p),
        Err(Error::BrokerRequired)
    ));
    assert!(matches!(
        adapt(
            pane_actions::Action::NewAgent {
                name: "agent".into(),
                harness: pane_actions::Harness::Codex
            },
            &p
        ),
        Err(Error::BrokerRequired)
    ));
}

/// A swap names its second pane by the token the drag captured; a pane the
/// presentation no longer holds at that token is stale, never sent.
#[test]
fn a_swap_to_an_unknown_target_is_stale() {
    let p = NativePresentation::new("scope", "workspace");
    assert!(matches!(
        adapt(
            pane_actions::Action::Swap {
                target: "right".into(),
                target_token: "token".into(),
            },
            &p
        ),
        Err(Error::Stale)
    ));
}
