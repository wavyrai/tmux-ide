use super::*;
#[test]
fn badge_updates_do_not_rotate_navigation_and_activation_clears_unread() {
    use herdr_client::tmux_daemon::{
        AgentActivity, ObservedAgent, ObservedHarness, ObservedNativePane,
    };
    let mut tabs = Tabs::default();
    tabs.accept(1, target(1));
    tabs.accept(2, target(2));
    let before = tabs.publish(2, true, &[target(1), target(2)]).unwrap();
    let mut agent = ObservedAgent {
        id: "agent".into(),
        name: "Agent".into(),
        harness: ObservedHarness::Custom,
        activity: AgentActivity::Running,
        attention: false,
        pane_id: Some("pane".into()),
        window_id: None,
        native_identity: Some(ObservedNativePane {
            server_epoch: "epoch".into(),
            pane_birth_id: "one".into(),
        }),
        interaction_endpoint: None,
        team: None,
    };
    tabs.rows[0]
        .activity
        .observe_once(uuid::Uuid::new_v4(), &[agent.clone()], false);
    agent.activity = AgentActivity::Complete;
    tabs.rows[0]
        .activity
        .observe_once(uuid::Uuid::new_v4(), &[agent], false);
    let after = tabs.publish(2, true, &[target(1), target(2)]).unwrap();
    assert!(after.rows[0].unread);
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.rows[0].activate, before.rows[0].activate);
    assert_eq!(after.rows[0].close, before.rows[0].close);
    tabs.accept(3, target(1));
    assert!(!tabs.publish(3, true, &[target(1), target(2)]).unwrap().rows[0].unread);
}
