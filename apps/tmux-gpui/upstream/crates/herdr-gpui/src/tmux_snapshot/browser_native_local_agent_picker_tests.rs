#![allow(clippy::unwrap_used)]
use super::super::tests::{agent, context, ready};
use super::*;
fn observation(kind: Kind, scope: u64, active: bool) -> Observation {
    Observation {
        kind,
        request: 0,
        scope,
        active,
        query: String::new(),
    }
}
#[test]
fn query_scopes_are_monotonic_and_old_closes_cannot_cancel_replacements() {
    let mut p = Picker::default();
    assert!(p.observe(observation(Kind::Palette, 1, true), 0, true));
    assert!(!p.observe(observation(Kind::Palette, 1, true), 0, true));
    assert!(p.observe(observation(Kind::Palette, 2, true), 0, true));
    assert!(!p.observe(observation(Kind::Palette, 1, false), 0, true));
    assert!(p.active(0));
    assert!(!p.observe(observation(Kind::Palette, 3, true), 0, false));
    assert!(!p.observe(observation(Kind::Palette, 2, false), 1, true));
    assert!(p.observe(observation(Kind::Attention, 1, true), 0, true));
    assert!(!p.observe(observation(Kind::Palette, 2, false), 0, true));
    assert!(p.observe(observation(Kind::Attention, 1, false), 0, false));
    assert!(!p.active(0));
    assert!(!p.observe(observation(Kind::Palette, 2, true), 0, true));
}
#[test]
fn bounds_and_consumed_navigation_attempts_are_fenced() {
    let mut p = Picker::default();
    assert!(!p.observe(observation(Kind::Palette, 0, true), 0, true));
    assert!(!p.observe(observation(Kind::Palette, MAX + 1, true), 0, true));
    let mut command = observation(Kind::Palette, 1, true);
    command.query = "é".repeat(257);
    assert!(!p.observe(command, 0, true));
    let mut command = observation(Kind::Palette, 1, true);
    command.query = "é".repeat(256);
    assert!(p.observe(command, 0, true));
    let bad = Rejected {
        request: 1,
        from_request: 0,
        scope: 2,
    };
    assert!(!p.admit(Kind::Palette, bad, 0, true));
    assert!(!p.admit(Kind::Palette, Rejected { scope: 1, ..bad }, 0, true));
    assert!(p.admit(
        Kind::Palette,
        Rejected {
            request: 2,
            scope: 1,
            ..bad
        },
        0,
        true
    ));
    p.cancel();
    assert!(!p.admit(
        Kind::Palette,
        Rejected {
            request: 3,
            scope: 1,
            ..bad
        },
        0,
        true
    ));
}
#[test]
fn palette_matches_all_terms_across_sanitized_metadata_before_projection() {
    let c = context();
    let a = agent();
    let result = AgentObservation {
        scope: c.scope.clone(),
        live_session_id: c.live.clone(),
        workspace_name: "fixture".into(),
        project_name: "Build Project".into(),
        agents: vec![a.clone()],
    };
    assert!(matches_query(
        &c,
        &result,
        &a,
        "JUMP buildagent local project codex"
    ));
    assert!(!matches_query(&c, &result, &a, "build nonexistent"));
    let mut gate = ready();
    assert!(gate.picker.observe(
        Observation {
            query: "buildagent project".into(),
            ..observation(Kind::Palette, 1, true)
        },
        0,
        true
    ));
    let mut state = State::default();
    gate.picker_publication(&mut state);
    assert_eq!(state.palette_agents.as_ref().unwrap().roster.rows.len(), 1);
    assert!(state.attention_agents.is_none());
    gate.picker
        .observe(observation(Kind::Attention, 1, true), 0, true);
    gate.picker_publication(&mut state);
    assert!(state.palette_agents.is_none());
    assert!(
        state
            .attention_agents
            .as_ref()
            .unwrap()
            .roster
            .rows
            .is_empty()
    );
    let Observed::Ready(result) = &mut gate.slots[0].observed else {
        unreachable!()
    };
    result.agents[0].attention = true;
    gate.picker_publication(&mut state);
    assert_eq!(
        state.attention_agents.as_ref().unwrap().roster.rows.len(),
        1
    );
    gate.suspend();
    gate.picker.failed = true;
    gate.picker_publication(&mut state);
    let p = state.attention_agents.as_ref().unwrap();
    assert!(p.valid());
    assert!(p.roster.phase == home_agents::Phase::Unavailable && p.roster.rows.is_empty());
}
