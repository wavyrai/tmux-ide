use super::*;
#[test]
#[ignore = "requires the explicit owned agent roster fixture"]
fn native_local_agent_roster_opens_exact_observed_pane() {
    assert_eq!(
        std::env::var("TMUX_IDE_NATIVE_TEST_AGENT_ROSTER").as_deref(),
        Ok("owned-agents")
    );
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let session = std::env::var("TMUX_IDE_TEST_INPUT_SESSION").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let home = until(&bridge, |s| {
        s.home_phase == HomePhase::Live && s.sessions.iter().any(|v| v.label == session)
    });
    let id = home
        .sessions
        .iter()
        .find(|v| v.label == session)
        .unwrap()
        .id
        .clone();
    bridge
        .commands
        .send(Command::Session { request: 1, id })
        .unwrap();
    let live = until(&bridge, |s| {
        s.request == 1
            && s.input_ready
            && s.workspace_agents.as_ref().is_some_and(|agents| {
                agents
                    .roster
                    .rows
                    .iter()
                    .any(|r| r.name == "Fixture native agent" && r.available)
            })
    });
    let roster = &live.workspace_agents.as_ref().unwrap().roster;
    let row = roster
        .rows
        .iter()
        .find(|r| r.name == "Fixture native agent" && r.available)
        .unwrap();
    let expected = row.pane_id.clone();
    bridge
        .commands
        .send(Command::OpenWorkspaceAgent {
            request: 2,
            from_request: 1,
            roster_revision: roster.revision,
            key: row.key.clone(),
            session_id: row.session_id.clone(),
        })
        .unwrap();
    let opened = until(&bridge, |s| s.request == 2 && s.input_ready);
    assert_eq!(opened.selected_pane, expected);
    bridge.commands.send(Command::Home { request: 3 }).unwrap();
    let home = until(&bridge, |s| {
        s.request == 3
            && s.home_agents.as_ref().is_some_and(|roster| {
                roster
                    .rows
                    .iter()
                    .any(|r| r.name == "Fixture native agent" && r.available)
            })
    });
    let roster = home.home_agents.as_ref().unwrap();
    let row = roster
        .rows
        .iter()
        .find(|r| r.name == "Fixture native agent" && r.available)
        .unwrap();
    assert_eq!(row.pane_id, expected);
    bridge
        .commands
        .send(Command::OpenAgent {
            request: 4,
            from_request: 3,
            roster_revision: roster.revision,
            key: row.key.clone(),
        })
        .unwrap();
    let opened = until(&bridge, |s| s.request == 4 && s.input_ready);
    assert_eq!(opened.selected_pane, expected);
    drop(bridge);
    owner.shutdown().unwrap();
}

#[test]
#[ignore = "requires the explicit owned appearance fixture"]
fn native_local_appearance_persists_without_helper() {
    assert_eq!(
        std::env::var("TMUX_IDE_NATIVE_TEST_APPEARANCE").as_deref(),
        Ok("owned-appearance")
    );
    let record = PathBuf::from(std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap());
    let config = PathBuf::from(std::env::var_os("TMUX_IDE_CONFIG").unwrap());
    assert_eq!(
        config,
        record
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("state/config.json")
    );
    let (bridge, owner) = start(record.clone(), Default::default()).unwrap();
    until(&bridge, |s| s.appearance.is_some());
    bridge
        .commands
        .send(Command::Appearance {
            system: crate::tmux_snapshot::appearance::System::Light,
        })
        .unwrap();
    until(&bridge, |s| {
        s.appearance
            .as_ref()
            .is_some_and(|a| a.system == crate::tmux_snapshot::appearance::System::Light)
    });
    bridge
        .commands
        .send(Command::Theme { id: "nord".into() })
        .unwrap();
    until(&bridge, |s| {
        s.appearance
            .as_ref()
            .is_some_and(|a| a.selected == "nord" && a.error.is_none())
    });
    bridge.commands.send(Command::Home { request: 1 }).unwrap();
    until(&bridge, |s| {
        s.request == 1
            && s.home_phase == HomePhase::Live
            && s.appearance.as_ref().is_some_and(|a| a.selected == "nord")
    });
    drop(bridge);
    owner.shutdown().unwrap();
    let (bridge, owner) = start(record, Default::default()).unwrap();
    until(&bridge, |s| {
        s.appearance
            .as_ref()
            .is_some_and(|a| a.selected == "nord" && a.valid())
    });
    drop(bridge);
    owner.shutdown().unwrap();
}

#[test]
#[ignore = "requires an explicit owned cross-machine agent fixture"]
fn native_home_agent_selection_crosses_machine_with_exact_pane_identity() {
    assert_eq!(
        std::env::var("TMUX_IDE_TEST_FLEET_AGENTS").as_deref(),
        Ok("owned-agents")
    );
    let record = std::env::var_os("TMUX_IDE_TEST_LOCAL_RECORD").unwrap();
    let profile = std::env::var("TMUX_IDE_TEST_SAVED_PROFILE").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let home = until(&bridge, |s| {
        s.home_phase == HomePhase::Live
            && s.home_agents.as_ref().is_some_and(|r| {
                r.rows
                    .iter()
                    .any(|a| a.name == "Fixture remote agent" && a.available)
            })
    });
    // Filtering changes observation scope, never terminal/navigation ownership.
    let revision = home.home_agents.as_ref().unwrap().revision;
    bridge
        .commands
        .send(Command::HomeAgentFilter {
            request: home.request,
            roster_revision: revision,
            machine_id: Some("local".into()),
        })
        .unwrap();
    let local = until(&bridge, |s| {
        s.home_agent_filter
            .as_ref()
            .is_some_and(|f| f.machine_id.as_deref() == Some("local"))
    });
    assert_eq!(local.request, home.request);
    assert!(
        local
            .home_agents
            .as_ref()
            .unwrap()
            .rows
            .iter()
            .all(|r| r.name != "Fixture remote agent")
    );
    bridge
        .commands
        .send(Command::HomeAgentFilter {
            request: local.request,
            roster_revision: local.home_agents.as_ref().unwrap().revision,
            machine_id: Some(profile.clone()),
        })
        .unwrap();
    let home = until(&bridge, |s| {
        s.home_agent_filter
            .as_ref()
            .is_some_and(|f| f.machine_id.as_ref() == Some(&profile))
            && s.home_agents.as_ref().is_some_and(|r| {
                r.rows
                    .iter()
                    .any(|a| a.name == "Fixture remote agent" && a.available)
            })
    });
    assert!(home.surface == Surface::Home);
    assert!(!home.input_ready);
    let roster = home.home_agents.as_ref().unwrap();
    let row = roster
        .rows
        .iter()
        .find(|r| r.name == "Fixture remote agent" && r.available)
        .unwrap();
    assert_eq!(row.machine_label.as_deref(), Some("Owned SSH fixture"));
    let expected = row.pane_id.clone();
    let expected_session = row.session_id.clone();
    assert!(home.fleet.as_ref().unwrap().groups.iter().any(|group| {
        group.id == profile
            && group
                .sessions
                .iter()
                .any(|session| session.session_id.as_deref() == Some(expected_session.as_str()))
    }));
    bridge
        .commands
        .send(Command::OpenAgent {
            request: 1,
            from_request: home.request,
            roster_revision: roster.revision,
            key: row.key.clone(),
        })
        .unwrap();
    let opened = until(&bridge, |s| {
        s.request == 1
            && s.input_ready
            && s.session_tabs
                .as_ref()
                .is_some_and(|tabs| tabs.request == 1 && tabs.active.is_some())
    });
    assert_eq!(opened.selected_pane, expected);
    assert_eq!(
        opened.selected_session.as_deref(),
        Some(expected_session.as_str())
    );
    let tabs = opened.session_tabs.as_ref().unwrap();
    let active = tabs
        .rows
        .iter()
        .find(|row| Some(&row.id) == tabs.active.as_ref())
        .unwrap();
    assert_eq!(active.host_label, "Owned SSH fixture");
    remote_picker::exercise(&bridge, expected, &expected_session);
    drop(bridge);
    owner.shutdown().unwrap();
    println!("NATIVE_FLEET_AGENT_SELECTED");
}

#[test]
#[ignore = "requires the explicit owned multi-page observation fixture"]
fn native_home_agent_recovery_loads_beyond_first_page_without_navigation() {
    use crate::tmux_snapshot::home::recovery::Action;
    assert_eq!(
        std::env::var("TMUX_IDE_NATIVE_TEST_AGENT_RECOVERY").as_deref(),
        Ok("owned-recovery")
    );
    let names: Vec<String> =
        serde_json::from_str(&std::env::var("TMUX_IDE_TEST_RECOVERY_SESSIONS").unwrap()).unwrap();
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    let home = until(&bridge, |s| {
        s.home_phase == HomePhase::Live && s.sessions.len() > 32
    });
    let target = home
        .sessions
        .iter()
        .skip(32)
        .find(|s| names.contains(&s.label))
        .unwrap();
    let label = target.label.clone();
    bridge
        .commands
        .send(Command::Session {
            request: 1,
            id: target.id.clone(),
        })
        .unwrap();
    until(&bridge, |s| s.request == 1 && s.input_ready);
    bridge.commands.send(Command::Home { request: 2 }).unwrap();
    let home = until(&bridge, |s| {
        s.request == 2
            && s.home_agent_recovery
                .as_ref()
                .is_some_and(|c| c.can_load_more)
    });
    assert!(home.sessions.iter().position(|s| s.label == label).unwrap() >= 32);
    let expected = format!(
        "Fixture recovery {}",
        names.iter().position(|name| name == &label).unwrap()
    );
    let roster = home.home_agents.as_ref().unwrap();
    assert!(roster.rows.iter().all(|r| r.name != expected));
    bridge
        .commands
        .send(Command::HomeAgentRecovery {
            request: 2,
            roster_revision: roster.revision,
            action: Action::LoadMore,
        })
        .unwrap();
    let loaded = until(&bridge, |s| {
        s.request == 2
            && s.home_agents.as_ref().is_some_and(|r| {
                r.truncated_sessions == 0
                    && r.rows.iter().any(|a| a.name == expected && a.available)
            })
    });
    assert!(
        loaded.surface == Surface::Home && !loaded.input_ready && loaded.selected_session.is_none()
    );
    assert!(!loaded.home_agent_recovery.as_ref().unwrap().can_load_more);
    // A complete healthy observation has nothing to retry. Sending its disabled
    // action must not navigate or consume the still-valid filter capability.
    assert!(!loaded.home_agent_recovery.as_ref().unwrap().can_retry);
    let revision = loaded.home_agents.as_ref().unwrap().revision;
    bridge
        .commands
        .send(Command::HomeAgentRecovery {
            request: 2,
            roster_revision: revision,
            action: Action::Retry,
        })
        .unwrap();
    bridge
        .commands
        .send(Command::HomeAgentFilter {
            request: 2,
            roster_revision: revision,
            machine_id: Some("local".into()),
        })
        .unwrap();
    let filtered = until(&bridge, |s| {
        s.request == 2
            && s.home_agent_filter
                .as_ref()
                .is_some_and(|c| c.machine_id.as_deref() == Some("local"))
    });
    assert!(
        filtered.surface == Surface::Home
            && !filtered.input_ready
            && filtered.selected_session.is_none()
    );
    drop(bridge);
    owner.shutdown().unwrap();
}

#[path = "browser_native_local_remote_picker_live_tests.rs"]
mod remote_picker;
