#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::tmux_daemon::{FleetCatalogSessions, Session};
fn catalog(environment: &str, generation: &str, rows: usize) -> FleetCatalog {
    let scope = ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: uuid::Uuid::new_v4().to_string(),
    };
    FleetCatalog {
        identity: CatalogIdentity {
            instance_id: generation.into(),
            environment_id: Some(environment.into()),
        },
        servers: vec![ServerRegistration::Online {
            label: "Server".into(),
            scope: scope.clone(),
        }],
        sessions: vec![FleetCatalogSessions {
            scope,
            sessions: (0..rows)
                .map(|n| Session {
                    live_session_id: format!("live-session.{n:020x}"),
                    session_name: format!("Session {n}"),
                    workspace_name: None,
                    pane_count: 1,
                })
                .collect(),
        }],
    }
}
fn state(own: &FleetCatalog) -> State {
    State {
        fleet: Some(fleet::Fleet {
            groups: vec![group("local", "Local", Some(own), false).unwrap()],
            omitted_groups: 0,
            preferences: None,
        }),
        ..State::default()
    }
}
fn add(gate: &mut Gate, id: &str, catalog: FleetCatalog) {
    gate.labels
        .insert(id.into(), (format!("Machine {id}"), uuid::Uuid::new_v4()));
    gate.catalogs.insert(id.into(), catalog);
}
#[test]
fn background_rows_have_stable_tokens_until_incarnation_changes_or_route_fails() {
    let own = catalog("local-env", "local-generation", 1);
    let mut gate = Gate::default();
    add(
        &mut gate,
        "remote",
        catalog("remote-env", "remote-generation", 2),
    );
    let mut first = state(&own);
    gate.project(&mut first, "local", Some(&own.identity))
        .unwrap();
    assert!(first.fleet.as_ref().unwrap().valid());
    let token = first.fleet.as_ref().unwrap().groups[1].sessions[0]
        .selection
        .clone()
        .unwrap();
    let mut again = state(&own);
    gate.project(&mut again, "local", Some(&own.identity))
        .unwrap();
    assert!(gate.selections.contains_key(&token));
    gate.labels.get_mut("remote").unwrap().1 = uuid::Uuid::new_v4();
    gate.project(&mut state(&own), "local", Some(&own.identity))
        .unwrap();
    assert!(!gate.selections.contains_key(&token));
    gate.failed.insert("remote".into());
    let mut failed = state(&own);
    gate.project(&mut failed, "local", Some(&own.identity))
        .unwrap();
    assert!(gate.selections.is_empty());
    let group = &failed.fleet.as_ref().unwrap().groups[1];
    assert!(group.state == fleet::Phase::Disconnected);
    assert!(
        group
            .sessions
            .iter()
            .all(|session| session.selection.is_none())
    );
}
#[test]
fn same_generation_aliases_join_and_conflicts_disable_selection_including_current() {
    let own = catalog("shared", "same", 1);
    let mut gate = Gate::default();
    add(&mut gate, "alias", catalog("shared", "same", 1));
    let mut value = state(&own);
    gate.project(&mut value, "local", Some(&own.identity))
        .unwrap();
    assert_eq!(value.fleet.as_ref().unwrap().groups.len(), 1);
    assert!(gate.allows_current());
    assert_eq!(gate.agent_group("local"), Some(true));
    assert_eq!(gate.agent_group("alias"), None);
    gate.catalogs.get_mut("alias").unwrap().identity.instance_id = "other".into();
    gate.failed.insert("alias".into());
    let mut value = state(&own);
    gate.project(&mut value, "local", Some(&own.identity))
        .unwrap();
    assert!(!gate.allows_current());
    assert_eq!(gate.agent_group("local"), Some(false));
    assert!(
        value
            .fleet
            .as_ref()
            .unwrap()
            .groups
            .iter()
            .all(|group| group.conflict)
    );
    assert!(gate.selections.is_empty());
    assert!(value.fleet.as_ref().unwrap().valid());
}
#[test]
fn combined_projection_obeys_global_session_and_group_budgets() {
    let own = catalog("local", "own", 128);
    let mut gate = Gate::default();
    for n in 0..64 {
        add(
            &mut gate,
            &format!("remote-{n:02}"),
            catalog(&format!("env-{n}"), "gen", 128),
        );
    }
    let mut value = state(&own);
    gate.project(&mut value, "local", Some(&own.identity))
        .unwrap();
    let fleet = value.fleet.unwrap();
    assert!(fleet.valid());
    assert_eq!(fleet.groups.len(), 64);
    assert_eq!(gate.agent_groups.len(), 64);
    assert_eq!(fleet.omitted_groups, 1);
    assert_eq!(
        fleet
            .groups
            .iter()
            .map(|group| group.sessions.len())
            .sum::<usize>(),
        512
    );
    assert!(
        fleet
            .groups
            .iter()
            .map(|group| group.omitted_sessions)
            .sum::<u64>()
            > 0
    );
    assert_eq!(
        gate.selections
            .values()
            .filter(|selection| matches!(selection.target, CatalogTarget::Session(_)))
            .count(),
        384
    );
}

#[cfg(unix)]
#[test]
fn failed_background_refresh_waits_for_registry_reread_and_honors_disable() {
    use herdr_client::tmux_daemon::{SavedMachine, SavedMachineRegistry};
    let mut machine = SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Fixture".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: None,
        enabled: true,
    };
    let registry = |machine: &SavedMachine| SavedMachineRegistry {
        version: 1,
        machines: vec![machine.clone()],
    };
    let path = std::env::temp_dir().join(format!("absent-fleet-refresh-{}", uuid::Uuid::new_v4()));
    let mut gate = Gate::default();
    gate.reconcile(Some(&path), registry(&machine), "local")
        .unwrap();
    let old = gate.labels[&machine.id].1;
    gate.failed.insert(machine.id.clone());
    gate.refresh();
    assert_eq!(gate.labels[&machine.id].1, old);
    gate.reconcile(Some(&path), registry(&machine), "local")
        .unwrap();
    assert_ne!(gate.labels[&machine.id].1, old);
    assert!(!gate.failed.contains(&machine.id));
    gate.failed.insert(machine.id.clone());
    gate.refresh();
    machine.enabled = false;
    gate.reconcile(Some(&path), registry(&machine), "local")
        .unwrap();
    assert!(gate.labels.is_empty());
    assert!(!gate.busy());
}

#[test]
fn preferences_use_verified_environment_per_group_and_route_keys_for_conflicts() {
    let own = catalog("own-env", "own", 1);
    let mut gate = Gate::default();
    add(&mut gate, "remote", catalog("remote-env", "remote", 1));
    assert_eq!(
        gate.preference_key("local", false, "local", Some(&own.identity)),
        "own-env"
    );
    assert_eq!(
        gate.preference_key("remote", false, "local", Some(&own.identity)),
        "remote-env"
    );
    assert_eq!(
        gate.preference_key("remote", true, "local", Some(&own.identity)),
        "remote"
    );
    assert_eq!(
        gate.preference_key("unknown", false, "local", Some(&own.identity)),
        "unknown"
    );
}

#[test]
fn server_tokens_are_bound_to_route_incarnation_and_exact_generation() {
    let own = catalog("local", "own", 1);
    let mut gate = Gate::default();
    add(&mut gate, "remote", catalog("remote", "daemon", 1));
    let mut value = state(&own);
    gate.project(&mut value, "local", Some(&own.identity))
        .unwrap();
    let token = value.fleet.as_ref().unwrap().groups[1].servers[0]
        .selection
        .clone()
        .unwrap();
    assert!(matches!(
        gate.selections[&token].target,
        CatalogTarget::Server(_)
    ));
    assert!(value.fleet.as_ref().unwrap().valid());
    let remote = gate.catalogs.get_mut("remote").unwrap();
    let generation = uuid::Uuid::new_v4().to_string();
    let ServerRegistration::Online { scope, .. } = &mut remote.servers[0] else {
        panic!("online fixture")
    };
    scope.generation.clone_from(&generation);
    remote.sessions[0].scope.generation = generation;
    let mut changed = state(&own);
    gate.project(&mut changed, "local", Some(&own.identity))
        .unwrap();
    assert!(!gate.selections.contains_key(&token));
    let replacement = changed.fleet.as_ref().unwrap().groups[1].servers[0]
        .selection
        .clone()
        .unwrap();
    assert!(gate.selections.contains_key(&replacement));
    gate.labels.get_mut("remote").unwrap().1 = uuid::Uuid::new_v4();
    gate.project(&mut state(&own), "local", Some(&own.identity))
        .unwrap();
    assert!(!gate.selections.contains_key(&replacement));
    gate.failed.insert("remote".into());
    gate.project(&mut state(&own), "local", Some(&own.identity))
        .unwrap();
    assert!(gate.selections.is_empty());
}

#[test]
fn connection_controls_are_typed_and_revoked_on_route_or_state_change() {
    let own = catalog("local-env", "local-generation", 1);
    let mut gate = Gate::default();
    add(
        &mut gate,
        "remote",
        catalog("remote-env", "remote-generation", 1),
    );
    let mut value = state(&own);
    gate.project(&mut value, "local", Some(&own.identity))
        .unwrap();
    assert!(value.fleet.as_ref().unwrap().valid());
    let token = value.fleet.as_ref().unwrap().groups[1]
        .disconnect
        .clone()
        .unwrap();
    assert!(!gate.controls[&token].retry);
    gate.disconnected.insert("remote".into());
    let mut stopped = state(&own);
    gate.project(&mut stopped, "local", Some(&own.identity))
        .unwrap();
    assert!(stopped.fleet.as_ref().unwrap().valid());
    assert!(!gate.controls.contains_key(&token));
    let group = &stopped.fleet.as_ref().unwrap().groups[1];
    assert!(group.disconnect.is_none());
    assert!(group.sessions.iter().all(|s| s.selection.is_none()));
    let retry = group.retry.clone().unwrap();
    assert!(gate.controls[&retry].retry);
    gate.labels.get_mut("remote").unwrap().1 = uuid::Uuid::new_v4();
    gate.project(&mut state(&own), "local", Some(&own.identity))
        .unwrap();
    assert!(!gate.controls.contains_key(&retry));
    gate.labels.clear();
    gate.project(&mut state(&own), "local", Some(&own.identity))
        .unwrap();
    assert!(gate.controls.is_empty());
}

#[test]
fn selected_disconnect_control_is_retired_when_source_is_replaced() {
    let own = catalog("remote-env", "remote-generation", 1);
    let mut gate = Gate::default();
    let make = || State {
        fleet: Some(fleet::Fleet {
            groups: vec![group("remote", "Remote", Some(&own), false).unwrap()],
            omitted_groups: 0,
            preferences: None,
        }),
        ..State::default()
    };
    let mut first = make();
    gate.project(&mut first, "remote", Some(&own.identity))
        .unwrap();
    assert!(first.fleet.as_ref().unwrap().valid());
    let token = first.fleet.as_ref().unwrap().groups[0]
        .disconnect
        .clone()
        .unwrap();
    assert!(gate.controls[&token].selected);
    gate.project(&mut make(), "remote", Some(&own.identity))
        .unwrap();
    assert!(gate.controls.contains_key(&token));
    gate.selected_epoch = uuid::Uuid::new_v4();
    gate.project(&mut make(), "remote", Some(&own.identity))
        .unwrap();
    assert!(!gate.controls.contains_key(&token));
    gate.project(&mut state(&own), "local", Some(&own.identity))
        .unwrap();
    assert!(gate.controls.is_empty());
}

#[test]
fn repeated_catalog_reads_do_not_republish_but_changes_and_recovery_do() {
    let mut gate = Gate::default();
    let original = catalog("remote-env", "remote-generation", 1);
    add(&mut gate, "remote", original.clone());
    let incarnation = gate.labels["remote"].1;
    let event = |incarnation, result| herdr_client::tmux_daemon::FleetCatalogEvent {
        route_id: "remote".into(),
        incarnation,
        result,
    };
    assert!(!gate.accept_catalog(event(incarnation, Ok(original.clone()))));
    let mut renamed = original.clone();
    renamed.sessions[0].sessions[0].session_name = "Renamed".into();
    assert!(gate.accept_catalog(event(incarnation, Ok(renamed.clone()))));
    assert!(!gate.accept_catalog(event(incarnation, Ok(renamed.clone()))));
    assert!(!gate.accept_catalog(event(uuid::Uuid::new_v4(), Ok(original))));
    assert!(gate.accept_catalog(event(
        incarnation,
        Err(herdr_client::tmux_daemon::Error::Retired)
    )));
    assert!(!gate.accept_catalog(event(
        incarnation,
        Err(herdr_client::tmux_daemon::Error::Retired)
    )));
    assert!(gate.accept_catalog(event(incarnation, Ok(renamed))));
}
