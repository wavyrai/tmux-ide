use super::*;
use crate::{
    LiveState, preferences::AgentSort, sidebar::agents::panel_agents, state::ConnectionStatus,
};
use herdr_client::ClientEvent;
use std::sync::Arc;

/// A daemon's listing of `(pane, status, state_change_seq)` agents.
fn listing(agents: &[(&str, AgentStatus, u64)]) -> Arc<ClientShellSnapshot> {
    let mut snapshot = layout_tests::snapshot(1);
    let template = snapshot.agents[0].clone();
    snapshot.agents = agents
        .iter()
        .map(|&(pane, agent_status, state_change_seq)| ClientShellAgent {
            pane_id: pane.into(),
            agent_status,
            state_change_seq,
            ..template.clone()
        })
        .collect();
    Arc::new(snapshot)
}

/// A connected host that just reported `agents`, its later ones changed last.
fn host(agents: &[(&str, AgentStatus)]) -> LiveState {
    let agents: Vec<_> = (1..)
        .zip(agents)
        .map(|(sequence, &(pane, status))| (pane, status, sequence))
        .collect();
    let mut live = LiveState::default();
    live.apply(ClientEvent::Snapshot(listing(&agents)));
    live
}

fn order<'a>(hosts: &[&'a LiveState], sort: AgentSort) -> Vec<(usize, &'a str)> {
    panel_agents(hosts.iter().copied().enumerate(), sort)
        .into_iter()
        .map(|(index, agent)| (index, agent.pane_id.as_str()))
        .collect()
}

#[test]
fn priority_merges_hosts_where_grouped_keeps_them_apart() {
    let first = host(&[
        ("idle", AgentStatus::Idle),
        ("working", AgentStatus::Working),
    ]);
    let second = host(&[
        ("done", AgentStatus::Done),
        ("blocked", AgentStatus::Blocked),
    ]);
    assert_eq!(
        order(&[&first, &second], AgentSort::Grouped),
        [(0, "idle"), (0, "working"), (1, "done"), (1, "blocked")]
    );
    // An agent wanting attention on the second host is no longer listed
    // below every agent of the first.
    assert_eq!(
        order(&[&first, &second], AgentSort::Priority),
        [(1, "blocked"), (1, "done"), (0, "working"), (0, "idle")]
    );
}

#[test]
fn equal_attention_goes_to_the_latest_change_on_any_host() {
    let mut first = host(&[("a", AgentStatus::Working)]);
    let second = host(&[("b", AgentStatus::Working)]);
    assert_eq!(
        order(&[&first, &second], AgentSort::Priority),
        [(1, "b"), (0, "a")]
    );
    // The first daemon's own sequence stays below the second's, as it would
    // when the second has simply counted more changes.
    first.apply(ClientEvent::Snapshot(listing(&[(
        "a",
        AgentStatus::Working,
        2,
    )])));
    assert_eq!(
        order(&[&first, &second], AgentSort::Priority),
        [(0, "a"), (1, "b")]
    );
}

#[test]
fn a_disconnected_hosts_last_known_agents_follow_connected_ones() {
    let mut detached = host(&[("stale", AgentStatus::Blocked)]);
    detached.status = ConnectionStatus::Detached;
    let connected = host(&[("live", AgentStatus::Idle)]);
    assert_eq!(
        order(&[&detached, &connected], AgentSort::Priority),
        [(1, "live"), (0, "stale")]
    );
}

#[test]
fn a_host_without_a_snapshot_lists_nothing() {
    let waiting = LiveState::default();
    let connected = host(&[
        ("idle", AgentStatus::Idle),
        ("blocked", AgentStatus::Blocked),
    ]);
    assert_eq!(
        order(&[&waiting, &connected], AgentSort::Grouped),
        [(1, "idle"), (1, "blocked")]
    );
    assert_eq!(
        order(&[&waiting, &connected], AgentSort::Priority),
        [(1, "blocked"), (1, "idle")]
    );
}

#[test]
fn a_plugin_view_keeps_every_host_in_its_own_order() {
    let mut viewed = host(&[("idle", AgentStatus::Idle), ("hidden", AgentStatus::Done)]);
    if let Some(snapshot) = viewed.snapshot.as_mut() {
        let snapshot = Arc::make_mut(snapshot);
        snapshot.agent_view_label = Some("review".into());
        snapshot.agent_order = vec!["idle".into()];
    }
    let other = host(&[
        ("idle", AgentStatus::Idle),
        ("blocked", AgentStatus::Blocked),
    ]);
    // The view's host lists only what the view orders; the other host sorts
    // locally, below it, as before hosts merged.
    assert_eq!(
        order(&[&viewed, &other], AgentSort::Priority),
        [(0, "idle"), (1, "blocked"), (1, "idle")]
    );
}
