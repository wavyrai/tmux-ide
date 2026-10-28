#![allow(clippy::unwrap_used)]
use super::*;
fn fixture() -> (CatalogIdentity, fleet::Group) {
    let value: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))
            .unwrap();
    let mut group: fleet::Group =
        serde_json::from_value(value["fleet"]["groups"][0].clone()).unwrap();
    let identity = CatalogIdentity {
        instance_id: "00000000-0000-4000-8000-000000000001".into(),
        environment_id: Some("00000000-0000-4000-8000-000000000002".into()),
    };
    let scope = ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: identity.instance_id.clone(),
    };
    group.servers.push(fleet::Server {
        id: scope.server_id.clone(),
        label: "Server".into(),
        state: fleet::ServerPhase::Online,
        generation: Some(scope.generation.clone()),
        selection: Some(uuid::Uuid::new_v4().to_string()),
    });
    group.sessions[0].server_id = Some(scope.server_id.clone());
    group.sessions[0].id = identity.session_key("local", &scope, "$1", false).unwrap();
    (identity, group)
}
#[test]
fn completed_catalog_caches_display_identity_without_live_selection_tokens() {
    let (identity, group) = fixture();
    let route = project("local", &identity, &group, 42).unwrap();
    assert_eq!(route.sessions.len(), 1);
    assert_eq!(route.sessions[0].id, group.sessions[0].id);
    assert_eq!(route.seen_at, 42);
    let wire = serde_json::to_string(&route).unwrap();
    assert!(!wire.contains(group.sessions[0].selection.as_ref().unwrap()));
    assert!(!wire.contains(group.servers[0].selection.as_ref().unwrap()));
    let mut newer = route.clone();
    newer.seen_at += 1000;
    assert!(unchanged(&route, &newer));
    newer.sessions[0].name = "renamed".into();
    assert!(!unchanged(&route, &newer));
    let mut replaced = route.clone();
    replaced.generation = Some("replacement".into());
    assert!(!unchanged(&route, &replaced));
}
#[test]
fn cache_projection_rejects_ephemeral_conflicting_or_unproved_sessions_and_bounds_rows() {
    let (identity, mut group) = fixture();
    assert!(project("native-ssh", &identity, &group, 1).is_none());
    group.conflict = true;
    assert!(project("local", &identity, &group, 1).is_none());
    group.conflict = false;
    group.sessions[0].id = "forged-key".into();
    assert!(
        project("local", &identity, &group, 1)
            .unwrap()
            .sessions
            .is_empty()
    );
    let (_, mut group) = fixture();
    group.sessions = vec![group.sessions[0].clone(); 129];
    assert_eq!(
        project("local", &identity, &group, 1)
            .unwrap()
            .sessions
            .len(),
        64
    );
    group.servers.clear();
    assert!(
        project("local", &identity, &group, 1)
            .unwrap()
            .sessions
            .is_empty()
    );
}
#[test]
fn ownerless_cache_is_not_submitted_and_failure_or_refresh_discards_queued_work() {
    let (identity, group) = fixture();
    let route = project("local", &identity, &group, 1).unwrap();
    let mut gate = Gate {
        pending_cache: Some(route.clone()),
        phase: fleet::PreferencePhase::Ready,
        needs_read: false,
        ..Gate::default()
    };
    assert!(gate.next_cache().is_none());
    assert!(gate.pending_cache.is_some());
    gate.failed();
    assert!(gate.pending_cache.is_none());
    gate.pending_cache = Some(route);
    gate.refresh();
    assert!(gate.pending_cache.is_none());
    assert!(gate.next_cache().is_none());
}

#[test]
fn invalid_persistent_display_data_is_skipped_before_a_write() {
    let (identity, mut group) = fixture();
    group.servers[0].label = "x".repeat(256);
    assert!(project("local", &identity, &group, 1).is_none());
    group.servers[0].label = "Server".into();
    group.sessions[0].name = "invalid\nname".into();
    assert!(project("local", &identity, &group, 1).is_none());
}
