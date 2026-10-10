use super::*;
use herdr_client::protocol::AgentStatus;

/// The daemon aggregates a workspace's and tab's status itself, so a
/// snapshot carries the same value on all three rows.
fn agent_snapshot(status: AgentStatus, sequence: u64) -> Arc<ClientShellSnapshot> {
    let mut snapshot = snapshot();
    let next = Arc::make_mut(&mut snapshot);
    next.agents[0].agent_status = status;
    next.agents[0].state_change_seq = sequence;
    next.tabs[0].agent_status = status;
    next.workspaces[0].agent_status = status;
    next.revision = sequence;
    snapshot
}

fn agent_surface(snapshot: &ClientShellSnapshot) -> Arc<PaneSurfaceFrame> {
    let mut frame = surface(snapshot);
    Arc::make_mut(&mut frame).panes.push(
        serde_json::from_value(serde_json::json!({
            "pane_id": snapshot.agents[0].pane_id,
            "content_revision": 1,
            "rect": {"x": 0, "y": 0, "width": 1, "height": 1},
            "inner_rect": {"x": 0, "y": 0, "width": 1, "height": 1},
            "focused": true, "mouse_reporting": false, "sgr_pixel_mouse": false,
            "alternate_screen_active": false, "pixel_width": 0, "pixel_height": 0
        }))
        .unwrap(),
    );
    frame
}

fn assert_status(state: &LiveState, status: AgentStatus) {
    let snapshot = state.snapshot.as_ref().unwrap();
    assert_eq!(snapshot.agents[0].agent_status, status);
    assert_eq!(snapshot.tabs[0].agent_status, status);
    assert_eq!(snapshot.workspaces[0].agent_status, status);
}

#[test]
fn daemon_status_reaches_the_sidebar_unchanged() {
    // Every client shows the same dot: painting a focused surface, changing
    // boot, or reconnecting must not rewrite what the daemon reported.
    let mut state = LiveState::default();
    state.set_outer_focus(true);
    for status in [
        AgentStatus::Working,
        AgentStatus::Done,
        AgentStatus::Idle,
        AgentStatus::Blocked,
    ] {
        let snapshot = agent_snapshot(status, 10);
        state.apply(ClientEvent::Snapshot(snapshot.clone()));
        state.apply(ClientEvent::Surface(agent_surface(&snapshot)));
        assert_status(&state, status);
    }
    let mut reboot = agent_snapshot(AgentStatus::Done, 100);
    Arc::make_mut(&mut reboot).boot_id = "new-boot".into();
    state.apply(ClientEvent::Snapshot(reboot));
    assert_status(&state, AgentStatus::Done);
    state.apply(ClientEvent::Disconnected {
        reason: "test".into(),
        ssh: None,
    });
    state.apply(ClientEvent::Snapshot(agent_snapshot(
        AgentStatus::Done,
        200,
    )));
    assert_status(&state, AgentStatus::Done);
}

#[test]
fn agent_view_projection_is_a_query_not_an_activity_override() {
    // This is the endpoint.agent-view.v1 envelope and AgentViewSetParams
    // shape from upstream, not a per-agent status payload.
    let mut state = LiveState::default();
    state.apply(ClientEvent::Snapshot(agent_snapshot(AgentStatus::Idle, 7)));
    state.apply(ClientEvent::Message(ServerMessage::EndpointControl {
        kind: "endpoint.agent-view.v1".into(),
        data: include_str!("../../../../herdr-protocol/tests/fixtures/endpoint-agent-view-v1.json")
            .into(),
    }));
    assert_status(&state, AgentStatus::Idle);
}
