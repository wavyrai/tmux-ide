#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::tmux_daemon::{AgentActivity, ObservedHarness, ObservedNativePane};
pub(super) fn context() -> Context {
    Context {
        machine: "local".into(),
        machine_label: "Local".into(),
        incarnation: None,
        readable: true,
        key: "session-key".into(),
        catalog_identity: CatalogIdentity {
            instance_id: uuid::Uuid::new_v4().to_string(),
            environment_id: None,
        },
        scope: ServerScope {
            server_id: format!("tmux-server.{}", "a".repeat(32)),
            generation: uuid::Uuid::new_v4().to_string(),
        },
        live: format!("live-session.{}", "a".repeat(20)),
        workspace: Some("fixture".into()),
        session_label: "Session".into(),
        server_label: Some("Server".into()),
    }
}
pub(super) fn agent() -> ObservedAgent {
    ObservedAgent {
        id: "agent.one".into(),
        name: "Build\nagent".into(),
        harness: ObservedHarness::Codex,
        activity: AgentActivity::Running,
        attention: false,
        pane_id: Some("pane.one".into()),
        window_id: None,
        native_identity: Some(ObservedNativePane {
            server_epoch: uuid::Uuid::new_v4().to_string(),
            pane_birth_id: "1".into(),
        }),
        interaction_endpoint: None,
        team: None,
    }
}
pub(super) fn ready() -> Gate {
    let mut gate = Gate::default();
    let context = context();
    gate.configure(vec![context.clone()], 1, false, 0, Instant::now());
    gate.epoch = Some(uuid::Uuid::new_v4());
    gate.slots[0].observed = Observed::Ready(AgentObservation {
        scope: context.scope,
        live_session_id: context.live,
        workspace_name: context.workspace.unwrap(),
        project_name: "Project".into(),
        agents: vec![agent()],
    });
    gate
}
#[test]
fn observed_rows_keep_context_and_private_revision_bound_selection() {
    let mut gate = ready();
    let roster = gate.publication();
    assert!(roster.valid());
    assert!(roster.phase == home_agents::Phase::Live);
    assert_eq!(roster.rows[0].name, "Buildagent");
    assert_eq!(roster.rows[0].server_label.as_deref(), Some("Server"));
    assert!(roster.rows[0].available);
    assert!(gate.resolve(&roster.rows[0].key, roster.revision).is_some());
    let updated = gate.publication();
    assert!(updated.revision > roster.revision);
    assert!(gate.resolve(&roster.rows[0].key, roster.revision).is_some());
    assert!(
        gate.resolve(&roster.rows[0].key, roster.revision - 1)
            .is_none()
    );
    assert!(
        gate.resolve(&roster.rows[0].key, updated.revision + 1)
            .is_none()
    );
    assert!(gate.resolve("unknown", updated.revision).is_none());
    gate.epoch = Some(uuid::Uuid::new_v4());
    let refreshed = gate.publication();
    assert!(gate.resolve(&roster.rows[0].key, roster.revision).is_none());
    assert!(
        gate.resolve(&refreshed.rows[0].key, roster.revision)
            .is_none()
    );
}
#[test]
fn unproven_agents_are_visible_but_cannot_be_opened() {
    let mut gate = ready();
    let Observed::Ready(value) = &mut gate.slots[0].observed else {
        unreachable!()
    };
    value.agents[0].native_identity = None;
    let roster = gate.publication();
    assert!(roster.valid());
    assert!(!roster.rows[0].available);
    assert!(gate.resolve(&roster.rows[0].key, roster.revision).is_none());
}
#[test]
fn hiding_or_changing_scope_revokes_rows_and_selection() {
    for suspend in [true, false] {
        let mut gate = ready();
        let roster = gate.publication();
        if suspend {
            assert!(gate.suspend());
            assert!(gate.due.is_none());
        } else {
            let mut next = gate.contexts[0].clone();
            next.scope.generation = uuid::Uuid::new_v4().to_string();
            assert!(gate.configure(vec![next], 1, false, 0, Instant::now()));
            assert!(gate.publication().phase == home_agents::Phase::Loading);
        }
        assert!(gate.resolve(&roster.rows[0].key, roster.revision).is_none());
    }
}
#[test]
fn large_catalogs_and_rosters_are_bounded_and_honestly_partial() {
    let mut gate = ready();
    let ctx = gate.contexts[0].clone();
    gate.configure(
        (0..40)
            .map(|i| {
                let mut c = ctx.clone();
                c.key = i.to_string();
                c
            })
            .collect(),
        40,
        false,
        0,
        Instant::now(),
    );
    assert_eq!(gate.contexts.len(), 32);
    for slot in &mut gate.slots {
        slot.observed = Observed::Ready(AgentObservation {
            scope: slot.context.scope.clone(),
            live_session_id: slot.context.live.clone(),
            workspace_name: "fixture".into(),
            project_name: "Project".into(),
            agents: (0..64)
                .map(|i| {
                    let mut a = agent();
                    a.id = i.to_string();
                    a.attention = i == 63;
                    a
                })
                .collect(),
        });
    }
    gate.epoch = Some(uuid::Uuid::new_v4());
    let roster = gate.publication();
    assert!(roster.valid());
    assert_eq!(roster.rows.len(), 256);
    assert_eq!(roster.truncated_rows, 1792);
    assert_eq!(roster.truncated_sessions, 8);
    assert!(roster.phase == home_agents::Phase::Partial);
    assert!(roster.rows[0].attention);
}

#[test]
fn machine_and_incarnation_distinguish_identical_session_identifiers() {
    use herdr_client::tmux_daemon::{FleetCatalogSessions, Session};
    let c = context();
    let catalog = FleetCatalog {
        identity: c.catalog_identity.clone(),
        servers: vec![],
        sessions: vec![FleetCatalogSessions {
            scope: c.scope.clone(),
            sessions: vec![Session {
                live_session_id: c.live.clone(),
                session_name: "Same session".into(),
                workspace_name: c.workspace.clone(),
                pane_count: 1,
            }],
        }],
    };
    let a = contexts(&catalog, "local", "Local", None, true, 32).remove(0);
    let b = contexts(
        &catalog,
        "remote",
        "Remote",
        Some(uuid::Uuid::new_v4()),
        true,
        32,
    )
    .remove(0);
    let replacement = contexts(
        &catalog,
        "remote",
        "Remote",
        Some(uuid::Uuid::new_v4()),
        true,
        32,
    )
    .remove(0);
    assert_ne!(a.key, b.key);
    assert_ne!(b.key, replacement.key);
    let mut gate = ready();
    gate.contexts = vec![a.clone(), b.clone()];
    gate.total = 2;
    let Observed::Ready(value) = &gate.slots[0].observed else {
        unreachable!()
    };
    let result = value.clone();
    gate.slots = vec![
        Slot {
            context: a,
            observed: Observed::Ready(result.clone()),
        },
        Slot {
            context: b,
            observed: Observed::Ready(result),
        },
    ];
    let roster = gate.publication();
    assert!(roster.valid());
    assert_eq!(roster.rows.len(), 2);
    assert_ne!(roster.rows[0].machine_label, roster.rows[1].machine_label);
    let old = roster
        .rows
        .iter()
        .find(|r| r.machine_label.as_deref() == Some("Remote"))
        .unwrap();
    assert_eq!(
        gate.resolve(&old.key, roster.revision).unwrap().0.machine,
        "remote"
    );
    assert!(gate.configure(vec![replacement], 1, false, 0, Instant::now()));
    assert!(gate.resolve(&old.key, roster.revision).is_none());
}
#[test]
fn failed_routes_revoke_rows_and_incomplete_fleet_is_not_reported_live() {
    let mut gate = ready();
    let old = gate.publication();
    let mut c = gate.contexts[0].clone();
    c.readable = false;
    assert!(gate.configure(vec![c], 1, false, 1, Instant::now()));
    assert!(gate.resolve(&old.rows[0].key, old.revision).is_none());
    assert!(gate.publication().phase == home_agents::Phase::Unavailable);
    gate.configure(vec![], 0, false, 1, Instant::now());
    assert!(gate.publication().phase == home_agents::Phase::Partial);
}

#[path = "browser_native_local_agent_recovery_tests.rs"]
mod recovery;

#[test]
fn filtering_precedes_row_limit_and_omitted_rows_lose_selection_rights() {
    let mut gate = ready();
    let ctx = gate.contexts[0].clone();
    gate.configure(
        (0..5)
            .map(|i| {
                let mut c = ctx.clone();
                c.key = format!("context-{i}");
                c
            })
            .collect(),
        5,
        false,
        0,
        Instant::now(),
    );
    for slot in &mut gate.slots {
        slot.observed = Observed::Ready(AgentObservation {
            scope: slot.context.scope.clone(),
            live_session_id: slot.context.live.clone(),
            workspace_name: "fixture".into(),
            project_name: "Project".into(),
            agents: (0..64)
                .map(|i| {
                    let mut a = agent();
                    a.id = format!("agent-{i:02}");
                    a.name = format!("Agent {i}");
                    a
                })
                .collect(),
        });
    }
    gate.epoch = Some(uuid::Uuid::new_v4());
    let filtered = gate.publication_matching(|c, _, a| c.key == "context-4" && a.id == "agent-63");
    assert_eq!(filtered.rows.len(), 1);
    assert_eq!(filtered.truncated_rows, 0);
    let key = filtered.rows[0].key.clone();
    assert!(gate.resolve(&key, filtered.revision).is_some());
    let all = gate.publication();
    assert_eq!(all.rows.len(), 256);
    assert_eq!(all.truncated_rows, 64);
    assert!(all.rows.iter().all(|r| r.key != key));
    assert!(gate.resolve(&key, filtered.revision).is_none());
    assert_eq!(gate.published.len(), 256);
    let restored = gate.publication_matching(|c, _, a| c.key == "context-4" && a.id == "agent-63");
    assert!(gate.resolve(&key, filtered.revision).is_none());
    assert!(gate.resolve(&key, restored.revision).is_some());
    assert_eq!(gate.published.len(), 1);
}
