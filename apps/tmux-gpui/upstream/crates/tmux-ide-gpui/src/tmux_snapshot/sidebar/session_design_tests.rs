use super::*;

#[test]
fn single_populated_server_is_compact_but_empty_and_offline_remain_visible() {
    let mut f = fleet_tests::fleet();
    f.groups[0].servers.truncate(1);
    f.groups[0].sessions.truncate(1);
    let mut state = browser::State {
        fleet: Some(f),
        ..Default::default()
    };
    let projected = rows(&state);
    assert_eq!(projected.len(), 2);
    assert!(projected[0].pane_count.is_none());
    assert_eq!(projected[1].depth, 0);
    assert!(matches!(
        projected[1].target,
        Some(Target::FleetSession { .. })
    ));
    state.fleet.as_mut().unwrap().groups[0].sessions.clear();
    assert!(
        rows(&state)
            .iter()
            .any(|r| r.pane_count.as_deref() == Some("No sessions"))
    );
    state.fleet.as_mut().unwrap().groups[0].servers[0].state = browser::fleet::ServerPhase::Offline;
    assert!(
        rows(&state)
            .iter()
            .any(|r| r.pane_count.as_deref() == Some("Offline"))
    );
}

#[test]
fn activity_join_requires_exact_machine_server_generation_and_live_session() {
    use crate::tmux_snapshot::workspace_fleet_agents::{Publication, SessionScope};
    let f = fleet_tests::fleet();
    let mut publication: Publication = serde_json::from_value(serde_json::json!({
        "request":7,"scope":2,"revision":3,"phase":"live","selectedKey":null,
        "observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null,
        "rows":[{"key":"opaque\u{0000}agent","sessionId":"session-a","paneId":"pane-a","name":"Coder",
        "sessionLabel":"Duplicate","projectName":"Real project","status":"BLOCKED","attention":true,"available":true}]
    })).unwrap();
    let scope = SessionScope {
        machine: "machine".into(),
        server: "server-a".into(),
        generation: f.groups[0].servers[0].generation.clone().unwrap(),
        session: "session-a".into(),
    };
    publication
        .sessions
        .insert("opaque\0agent".into(), scope.clone());
    let mut state = browser::State {
        request: 7,
        surface: browser::Surface::Workspace,
        fleet: Some(f),
        workspace_fleet_agents: Some(publication),
        ..Default::default()
    };
    let projected = rows(&state);
    let i = projected
        .iter()
        .position(
            |r| matches!(&r.target, Some(Target::FleetSession { id, .. }) if id == "canonical-a"),
        )
        .unwrap();
    assert_eq!(projected[i].attention, 1);
    assert_eq!(projected[i].summary.as_deref(), Some("Real project"));
    assert_eq!(projected[i + 1].agent.as_deref(), Some("opaque\0agent"));
    assert!(!projected.iter().any(|r| r.label == "Agent activity"));
    for part in 0..4 {
        let mut wrong = scope.clone();
        match part {
            0 => wrong.machine = "other".into(),
            1 => wrong.server = "other".into(),
            2 => wrong.generation = "other".into(),
            _ => wrong.session = "other".into(),
        }
        state
            .workspace_fleet_agents
            .as_mut()
            .unwrap()
            .sessions
            .insert("opaque\0agent".into(), wrong);
        let projected = rows(&state);
        assert!(
            projected
                .iter()
                .all(|r| r.attention == 0 && r.summary.is_none())
        );
        assert!(projected.iter().any(|r| r.label == "Agent activity"));
        assert_eq!(projected.iter().filter(|r| r.agent.is_some()).count(), 1);
    }
}

#[test]
fn session_selection_does_not_reorder_sidebar_rows() {
    let mut state = browser::State {
        fleet: Some(fleet_tests::fleet()),
        ..Default::default()
    };
    let before: Vec<_> = rows(&state).into_iter().map(|r| r.label).collect();
    let group = &mut state.fleet.as_mut().unwrap().groups[0];
    group.sessions.reverse();
    for session in &mut group.sessions {
        session.active = session.id == "ordinary";
    }
    let after: Vec<_> = rows(&state).into_iter().map(|r| r.label).collect();
    assert_eq!(before, after);
}
