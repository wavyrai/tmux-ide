#![allow(clippy::unwrap_used)]
use super::*;
fn fleet() -> fleet::Fleet {
    let fixture: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../../../fixtures/browser-fleet.json"))
            .unwrap();
    serde_json::from_value(fixture["fleet"].clone()).unwrap()
}
#[test]
fn projection_retains_values_while_loading_but_grants_no_actions_without_owner_proof() {
    let mut value = fleet();
    let key = value.groups[0].sessions[0].id.clone();
    let mut gate = Gate {
        state: Some(FleetClientState {
            version: 1,
            favorites: vec![key.clone()],
            collapsed: vec!["environment".into()],
            recent: vec![],
            catalog: vec![],
        }),
        ..Gate::default()
    };
    gate.begin(false);
    gate.project(&mut value, "environment", Some(&key));
    assert!(value.valid());
    assert!(value.groups[0].collapsed);
    assert!(value.groups[0].sessions[0].favorite && value.groups[0].sessions[0].active);
    assert!(
        value.groups.iter().all(|g| g.collapse_action.is_none()
            && g.sessions.iter().all(|s| s.favorite_action.is_none()))
    );
    gate.phase = fleet::PreferencePhase::Ready;
    gate.project(&mut value, "environment", None);
    assert!(value.groups[0].collapse_action.is_none());
    assert!(gate.consume(gate.revision, "invented", true).is_none());
}
#[test]
fn failed_write_clears_acknowledgement_without_automatic_retry() {
    let mut gate = Gate::default();
    let mut value = fleet();
    gate.begin(true);
    gate.failed();
    gate.project(&mut value, "local", None);
    assert!(!gate.needs_read);
    assert!(gate.owner.is_none() && gate.state.is_none());
    assert!(value.valid());
    assert!(value.preferences.unwrap().phase == fleet::PreferencePhase::Failed);
    gate.refresh();
    assert!(gate.needs_read);
}

#[test]
fn published_groups_use_independent_collapse_keys_and_revoke_hidden_controls() {
    let mut value = fleet();
    let mut other = value.groups[0].clone();
    other.id = "other".into();
    other.label = "Other".into();
    other.retry = None;
    other.disconnect = None;
    other.collapse_action = None;
    for server in &mut other.servers {
        server.selection = None;
    }
    for session in &mut other.sessions {
        session.selection = None;
        session.favorite_action = None;
    }
    value.groups.push(other);
    let first = value.groups[0].id.clone();
    let second = value.groups[1].id.clone();
    let keys = BTreeMap::from([(first, "env-one".into()), (second, "env-two".into())]);
    let mut gate = Gate {
        state: Some(FleetClientState {
            version: 1,
            favorites: vec![],
            collapsed: vec!["env-two".into()],
            recent: vec![],
            catalog: vec![],
        }),
        ..Gate::default()
    };
    let stale = uuid::Uuid::new_v4().to_string();
    gate.actions
        .insert(stale.clone(), (Kind::Favorite, "not-published".into()));
    gate.project_published(&mut value, &keys, None);
    assert!(!value.groups[0].collapsed);
    assert!(value.groups[1].collapsed);
    assert!(!gate.actions.contains_key(&stale));
    assert!(
        value
            .groups
            .iter()
            .all(|group| group.collapse_action.is_none())
    );
    assert!(value.valid());
}
