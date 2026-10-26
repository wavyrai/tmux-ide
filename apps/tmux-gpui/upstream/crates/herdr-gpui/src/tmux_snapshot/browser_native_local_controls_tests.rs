//! Foreground connection controls must not be lost behind background reads.
use super::*;
fn selected(local: &mut Local) -> String {
    let value: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))
            .unwrap();
    let mut fleet: fleet::Fleet = serde_json::from_value(value["fleet"].clone()).unwrap();
    fleet.groups.truncate(1);
    fleet.groups[0].id = "remote".into();
    fleet.groups[0].state = fleet::Phase::Ready;
    fleet.groups[0].conflict = false;
    local.machine_id = "remote".into();
    local.state.fleet = Some(fleet);
    let mut publication = local.state.clone();
    local
        .background_fleet
        .project(&mut publication, "remote", None)
        .unwrap();
    publication.fleet.unwrap().groups[0]
        .disconnect
        .clone()
        .unwrap()
}
#[test]
fn disconnect_restarts_a_pending_registry_read_and_submits_only_read_work() {
    let (mut local, _events) = fixture();
    let disconnect = selected(&mut local);
    local.stage = Some(Stage::Machines { change: None });
    local.submitted = true;
    local
        .command(Command::FleetDisconnect {
            request: 0,
            disconnect,
        })
        .unwrap();
    assert!(matches!(
        local.stage,
        Some(Stage::Machines { change: None })
    ));
    assert!(!local.submitted);
    assert_eq!(local.machine_id, "remote");
}
#[test]
fn disconnect_preempts_background_preferences() {
    let (mut local, _events) = fixture();
    let disconnect = selected(&mut local);
    local.stage = Some(Stage::Preferences { change: None });
    local.submitted = true;
    local
        .command(Command::FleetDisconnect {
            request: 0,
            disconnect,
        })
        .unwrap();
    assert!(matches!(
        local.stage,
        Some(Stage::Machines { change: None })
    ));
    assert!(!local.submitted);
    assert_eq!(local.machine_id, "remote");
}
