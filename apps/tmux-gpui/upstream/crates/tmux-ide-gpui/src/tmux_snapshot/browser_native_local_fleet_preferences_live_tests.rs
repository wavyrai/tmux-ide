//! Owned live fixture: preferences for a background route use the local owner.
use super::*;
pub(super) fn exercise(bridge: &Bridge, home: State, profile: &str, name: &str) -> State {
    let request = home.request;
    let ready = if preferences_ready(&home) {
        home
    } else {
        until(bridge, |s| s.request == request && preferences_ready(s))
    };
    let fleet = ready.fleet.as_ref().unwrap();
    let group = fleet.groups.iter().find(|g| g.id == profile).unwrap();
    let row = group.sessions.iter().find(|row| row.name == name).unwrap();
    let key = row.id.clone();
    let revision = fleet.preferences.as_ref().unwrap().revision;
    let stale = row.favorite_action.clone().unwrap();
    bridge
        .commands
        .send(Command::FleetPreference {
            request,
            revision,
            action: stale.clone(),
            enabled: true,
        })
        .unwrap();
    let saved = until(bridge, |s| {
        s.request == request
            && preferences_ready(s)
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups.iter().any(|g| {
                    g.id == profile && g.sessions.iter().any(|row| row.id == key && row.favorite)
                })
            })
    });
    // A pre-write token cannot undo the completed write.
    bridge
        .commands
        .send(Command::FleetPreference {
            request,
            revision,
            action: stale,
            enabled: false,
        })
        .unwrap();
    let fleet = saved.fleet.as_ref().unwrap();
    let group = fleet.groups.iter().find(|g| g.id == profile).unwrap();
    bridge
        .commands
        .send(Command::FleetPreference {
            request,
            revision: fleet.preferences.as_ref().unwrap().revision,
            action: group.collapse_action.clone().unwrap(),
            enabled: true,
        })
        .unwrap();
    let collapsed = until(bridge, |s| {
        s.request == request
            && preferences_ready(s)
            && s.fleet
                .as_ref()
                .is_some_and(|f| f.groups.iter().any(|g| g.id == profile && g.collapsed))
    });
    let fleet = collapsed.fleet.as_ref().unwrap();
    assert!(
        !fleet
            .groups
            .iter()
            .find(|g| g.id == "local")
            .unwrap()
            .collapsed
    );
    let group = fleet.groups.iter().find(|g| g.id == profile).unwrap();
    assert!(
        group
            .sessions
            .iter()
            .any(|row| row.id == key && row.favorite)
    );
    bridge
        .commands
        .send(Command::FleetPreference {
            request,
            revision: fleet.preferences.as_ref().unwrap().revision,
            action: group.collapse_action.clone().unwrap(),
            enabled: false,
        })
        .unwrap();
    let expanded = until(bridge, |s| {
        s.request == request
            && preferences_ready(s)
            && s.fleet
                .as_ref()
                .is_some_and(|f| f.groups.iter().any(|g| g.id == profile && !g.collapsed))
    });
    let fleet = expanded.fleet.as_ref().unwrap();
    let row = fleet
        .groups
        .iter()
        .find(|g| g.id == profile)
        .unwrap()
        .sessions
        .iter()
        .find(|r| r.id == key)
        .unwrap();
    bridge
        .commands
        .send(Command::FleetPreference {
            request,
            revision: fleet.preferences.as_ref().unwrap().revision,
            action: row.favorite_action.clone().unwrap(),
            enabled: false,
        })
        .unwrap();
    let restored = until(bridge, |s| {
        s.request == request
            && preferences_ready(s)
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups.iter().any(|g| {
                    g.id == profile && g.sessions.iter().any(|row| row.id == key && !row.favorite)
                })
            })
    });
    assert!(restored.frame.is_none());
    eprintln!("NATIVE_BACKGROUND_FLEET_PREFERENCES_VERIFIED");
    restored
}
