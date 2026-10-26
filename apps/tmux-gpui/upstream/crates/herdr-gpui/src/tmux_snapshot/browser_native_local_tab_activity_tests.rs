use super::*;
fn agent(activity: AgentActivity, birth: &str) -> ObservedAgent {
    ObservedAgent {
        id: "agent".into(),
        name: "Agent".into(),
        harness: herdr_client::tmux_daemon::ObservedHarness::Custom,
        activity,
        attention: false,
        pane_id: Some("pane".into()),
        window_id: None,
        native_identity: Some(ObservedNativePane {
            server_epoch: "epoch".into(),
            pane_birth_id: birth.into(),
        }),
        interaction_endpoint: None,
        team: None,
    }
}
#[test]
fn completion_requires_continuous_exact_identity_and_clears_on_activation() {
    let mut badge = Badge::default();
    badge.observe(&[agent(AgentActivity::Complete, "one")], false);
    assert!(!badge.unread);
    badge.observe(&[agent(AgentActivity::Running, "one")], false);
    badge.observe(&[agent(AgentActivity::Complete, "two")], false);
    assert!(!badge.unread);
    badge.observe(&[agent(AgentActivity::Running, "two")], false);
    badge.unavailable();
    badge.observe(&[agent(AgentActivity::Complete, "two")], false);
    assert!(!badge.unread);
    badge.observe(&[agent(AgentActivity::Running, "two")], false);
    badge.observe(&[agent(AgentActivity::Complete, "two")], false);
    assert!(badge.unread);
    badge.unavailable();
    assert!(badge.unread && badge.activity.is_none());
    badge.observe(&[agent(AgentActivity::Complete, "two")], true);
    assert!(!badge.unread);
}
#[test]
fn badge_priority_and_bounds_match_observation_contract() {
    let mut badge = Badge::default();
    let mut attention = agent(AgentActivity::Idle, "one");
    attention.attention = true;
    badge.observe(
        &[agent(AgentActivity::Running, "two"), attention.clone()],
        false,
    );
    assert!(matches!(badge.activity, Some(Activity::Waiting)));
    badge.observe(&[attention, agent(AgentActivity::Failed, "two")], false);
    assert!(matches!(badge.activity, Some(Activity::Failed)));
    badge.observe(&vec![agent(AgentActivity::Running, "one"); 65], false);
    assert!(badge.activity.is_none() && badge.previous.is_empty());
}

#[test]
fn one_observation_epoch_is_processed_once_and_pane_changes_do_not_complete_old_work() {
    let mut badge = Badge::default();
    let epoch = uuid::Uuid::new_v4();
    badge.observe_once(epoch, &[agent(AgentActivity::Running, "one")], false);
    badge.observe_once(epoch, &[agent(AgentActivity::Complete, "one")], false);
    assert!(!badge.unread && matches!(badge.activity, Some(Activity::Running)));
    let mut changed = agent(AgentActivity::Complete, "one");
    changed.pane_id = Some("replacement".into());
    badge.observe_once(uuid::Uuid::new_v4(), &[changed], false);
    assert!(!badge.unread);
    let mut unknown = agent(AgentActivity::Running, "one");
    unknown.native_identity = None;
    badge.observe_once(uuid::Uuid::new_v4(), &[unknown], false);
    assert!(badge.activity.is_none() && badge.previous.is_empty());
}
