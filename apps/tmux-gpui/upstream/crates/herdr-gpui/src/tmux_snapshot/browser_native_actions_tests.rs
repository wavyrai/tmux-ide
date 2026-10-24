use super::*;
#[test]
fn maps_semantic_actions_without_inventing_owner_authority() {
    assert!(matches!(
        adapt(pane_actions::Action::Close),
        Ok(PaneAction::Close)
    ));
    assert!(matches!(
        adapt(pane_actions::Action::Zoom {
            desired: pane_actions::Zoom::Unzoomed
        }),
        Ok(PaneAction::Zoom(Zoom::Unzoomed))
    ));
    assert!(matches!(
        adapt(pane_actions::Action::Split {
            direction: pane_actions::SplitDirection::Down
        }),
        Ok(PaneAction::Split(Direction::Down))
    ));
    assert!(
        matches!(adapt(pane_actions::Action::Rename{name:"name".into()}),Ok(PaneAction::Rename(name)) if name=="name")
    );
    assert!(matches!(
        adapt(pane_actions::Action::NewWindow),
        Err(Error::BrokerRequired)
    ));
    assert!(matches!(
        adapt(pane_actions::Action::NewAgent {
            name: "agent".into(),
            harness: pane_actions::Harness::Codex
        }),
        Err(Error::BrokerRequired)
    ));
}
