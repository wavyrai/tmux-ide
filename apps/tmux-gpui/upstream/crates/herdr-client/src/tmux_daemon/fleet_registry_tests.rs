#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_daemon::SavedMachine;
fn profile() -> SavedMachine {
    SavedMachine {
        id: uuid::Uuid::new_v4().to_string(),
        label: "Fixture".into(),
        ssh_target: "fixture.invalid".into(),
        expected_environment_id: Some(uuid::Uuid::new_v4().to_string()),
        enabled: true,
    }
}
fn registry(profile: &SavedMachine) -> SavedMachineRegistry {
    SavedMachineRegistry {
        version: 1,
        machines: vec![profile.clone()],
    }
}
fn fleet() -> FleetRegistry {
    FleetRegistry::new(
        std::env::temp_dir().join(format!("absent-registry-{}", uuid::Uuid::new_v4())),
    )
}
fn incarnation(fleet: &FleetRegistry, id: &str) -> uuid::Uuid {
    fleet.routes().find(|(key, _, _)| *key == id).unwrap().2
}
#[test]
fn label_change_preserves_transport_but_target_and_pin_change_retire_it() {
    let mut fleet = fleet();
    let mut machine = profile();
    assert!(fleet.reconcile(registry(&machine), "local").unwrap());
    let old = incarnation(&fleet, &machine.id);
    assert!(!fleet.reconcile(registry(&machine), "local").unwrap());
    machine.label = "Renamed".into();
    assert!(fleet.reconcile(registry(&machine), "local").unwrap());
    assert_eq!(incarnation(&fleet, &machine.id), old);
    assert_eq!(fleet.routes().next().unwrap().1, "Renamed");
    machine.ssh_target = "replacement.invalid".into();
    fleet.reconcile(registry(&machine), "local").unwrap();
    let retargeted = incarnation(&fleet, &machine.id);
    assert_ne!(retargeted, old);
    assert!(!fleet.current(&machine.id, old));
    machine.expected_environment_id = Some(uuid::Uuid::new_v4().to_string());
    fleet.reconcile(registry(&machine), "local").unwrap();
    assert_ne!(incarnation(&fleet, &machine.id), retargeted);
    fleet.invalidate().unwrap();
    assert_eq!(fleet.routes().count(), 0);
    assert!(!fleet.busy());
}
#[test]
fn disabling_removing_and_selecting_foreground_revoke_background_incarnation() {
    let mut fleet = fleet();
    let mut machine = profile();
    fleet.reconcile(registry(&machine), "local").unwrap();
    let old = incarnation(&fleet, &machine.id);
    machine.enabled = false;
    fleet.reconcile(registry(&machine), "local").unwrap();
    assert_eq!(fleet.routes().count(), 0);
    assert!(!fleet.current(&machine.id, old));
    machine.enabled = true;
    fleet.reconcile(registry(&machine), "local").unwrap();
    assert_ne!(incarnation(&fleet, &machine.id), old);
    fleet.reconcile(registry(&machine), &machine.id).unwrap();
    assert!(!fleet.current(&machine.id, old));
    assert_eq!(
        fleet.routes().map(|(id, _, _)| id).collect::<Vec<_>>(),
        ["local"]
    );
    fleet
        .reconcile(
            SavedMachineRegistry {
                version: 1,
                machines: vec![],
            },
            "local",
        )
        .unwrap();
    assert!(!fleet.busy());
    assert_eq!(fleet.routes().count(), 0);
}
#[test]
fn invalid_registry_revokes_previous_background_authority_before_error() {
    let mut fleet = fleet();
    let machine = profile();
    fleet.reconcile(registry(&machine), "local").unwrap();
    let old = incarnation(&fleet, &machine.id);
    let mut invalid = registry(&machine);
    invalid.machines.push(machine.clone());
    assert!(matches!(
        fleet.reconcile(invalid, "local"),
        Err(FleetRegistryError::Registry(_))
    ));
    assert!(!fleet.current(&machine.id, old));
    assert!(!fleet.busy());
    fleet.reconcile(registry(&machine), "local").unwrap();
    assert_ne!(incarnation(&fleet, &machine.id), old);
    // Repeated refreshes remain a single queued read, not implicit network work.
    for _ in 0..100 {
        fleet.refresh().unwrap();
    }
    fleet.invalidate().unwrap();
    assert!(!fleet.busy());
    assert!(fleet.poll().unwrap().is_empty());
}

#[test]
fn retry_retires_old_incarnation_and_stale_retries_cannot_replace_current_route() {
    let mut fleet = fleet();
    let machine = profile();
    fleet.reconcile(registry(&machine), "local").unwrap();
    let old = incarnation(&fleet, &machine.id);
    let next = fleet.retry(&machine.id, old).unwrap().unwrap();
    assert_ne!(old, next);
    assert!(!fleet.current(&machine.id, old));
    assert!(fleet.current(&machine.id, next));
    assert!(fleet.retry(&machine.id, old).unwrap().is_none());
    assert_eq!(incarnation(&fleet, &machine.id), next);
    fleet.invalidate().unwrap();
    assert!(fleet.retry(&machine.id, next).unwrap().is_none());
    assert!(!fleet.busy());
}

#[test]
fn disconnect_is_inert_until_explicit_retry_and_rejects_old_controls() {
    let mut fleet = fleet();
    let mut machine = profile();
    fleet.reconcile(registry(&machine), "local").unwrap();
    let old = incarnation(&fleet, &machine.id);
    let stopped = fleet.disconnect(&machine.id, old).unwrap().unwrap();
    assert_ne!(old, stopped);
    assert!(!fleet.current(&machine.id, old));
    assert!(fleet.disconnected(&machine.id));
    assert!(!fleet.busy());
    assert!(fleet.pool.incarnation(&machine.id).is_none());
    machine.label = "Renamed while disconnected".into();
    fleet.reconcile(registry(&machine), "local").unwrap();
    fleet.refresh().unwrap();
    assert!(fleet.poll().unwrap().is_empty());
    assert_eq!(incarnation(&fleet, &machine.id), stopped);
    assert!(!fleet.busy());
    assert!(fleet.retry(&machine.id, old).unwrap().is_none());
    assert!(fleet.disconnect(&machine.id, stopped).unwrap().is_none());
    let resumed = fleet.retry(&machine.id, stopped).unwrap().unwrap();
    assert_ne!(resumed, stopped);
    assert!(!fleet.disconnected(&machine.id));
    assert!(fleet.busy());
    assert!(fleet.disconnect(&machine.id, stopped).unwrap().is_none());
    fleet.invalidate().unwrap();
}

#[test]
fn changed_binding_revokes_disconnected_route_and_its_retry_authority() {
    let mut fleet = fleet();
    let mut machine = profile();
    fleet.reconcile(registry(&machine), "local").unwrap();
    let old = incarnation(&fleet, &machine.id);
    let stopped = fleet.disconnect(&machine.id, old).unwrap().unwrap();
    machine.ssh_target = "replacement.invalid".into();
    fleet.reconcile(registry(&machine), "local").unwrap();
    assert!(!fleet.disconnected(&machine.id));
    assert!(fleet.retry(&machine.id, stopped).unwrap().is_none());
    assert!(fleet.busy());
    fleet.invalidate().unwrap();
}
