use super::*;
use herdr_client::protocol::ClientShellAgent;

/// A snapshot from `boot` listing one agent per `(pane, state_change_seq)`.
fn agents(boot: &str, panes: &[(&str, u64)]) -> Arc<ClientShellSnapshot> {
    let mut snapshot = snapshot();
    let next = Arc::make_mut(&mut snapshot);
    next.boot_id = boot.into();
    let template = next.agents[0].clone();
    next.agents = panes
        .iter()
        .map(|&(pane, state_change_seq)| ClientShellAgent {
            pane_id: pane.into(),
            state_change_seq,
            ..template.clone()
        })
        .collect();
    snapshot
}

#[test]
fn changes_on_different_daemons_order_as_they_arrive() {
    let (mut first, mut second) = (LiveState::default(), LiveState::default());
    // The first daemon has counted far more changes than the second, which
    // says nothing about which of their agents changed last.
    first.apply(ClientEvent::Snapshot(agents("one", &[("a", 50)])));
    second.apply(ClientEvent::Snapshot(agents("two", &[("b", 2)])));
    assert!(second.agent_recency.of("b") > first.agent_recency.of("a"));
    first.apply(ClientEvent::Snapshot(agents("one", &[("a", 51)])));
    assert!(first.agent_recency.of("a") > second.agent_recency.of("b"));
}

#[test]
fn only_a_changed_agent_is_restamped_and_older_changes_stamp_first() {
    let mut state = LiveState::default();
    state.apply(ClientEvent::Snapshot(agents(
        "boot",
        &[("late", 7), ("early", 3)],
    )));
    let late = state.agent_recency.of("late");
    assert!(late > state.agent_recency.of("early"));
    state.apply(ClientEvent::Snapshot(agents(
        "boot",
        &[("late", 7), ("early", 8)],
    )));
    assert_eq!(state.agent_recency.of("late"), late);
    assert!(state.agent_recency.of("early") > late);
}

#[test]
fn history_ends_with_its_pane_boot_or_connection() {
    let mut state = LiveState::default();
    state.apply(ClientEvent::Snapshot(agents(
        "boot",
        &[("kept", 1), ("closed", 2)],
    )));
    state.apply(ClientEvent::Snapshot(agents("boot", &[("kept", 1)])));
    assert_eq!(state.agent_recency.of("closed"), 0);
    let kept = state.agent_recency.of("kept");
    assert!(kept > 0);
    // A restarted daemon reuses pane IDs for unrelated panes.
    state.apply(ClientEvent::Snapshot(agents("rebooted", &[("kept", 1)])));
    assert!(state.agent_recency.of("kept") > kept);
    state.apply(ClientEvent::Disconnected {
        reason: "gone".into(),
        ssh: None,
    });
    assert_eq!(state.agent_recency, AgentRecency::default());
}
