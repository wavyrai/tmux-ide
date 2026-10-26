use super::*;
pub(super) fn exercise(bridge: &Bridge, expected: Option<String>, session: &str) {
    bridge.commands.send(Command::Home { request: 2 }).unwrap();
    let home = until(bridge, |s| {
        s.request == 2
            && s.home_phase == HomePhase::Live
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups
                    .iter()
                    .any(|g| g.id == "local" && g.sessions.iter().any(|s| s.selection.is_some()))
            })
    });
    let selection = home
        .fleet
        .as_ref()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.id == "local")
        .unwrap()
        .sessions
        .iter()
        .find_map(|s| s.selection.clone())
        .unwrap();
    bridge
        .commands
        .send(Command::FleetSession {
            request: 3,
            selection,
        })
        .unwrap();
    let local = until(bridge, |s| s.request == 3 && s.input_ready);
    for request in 3..5 {
        let attention = request == 4;
        bridge
            .commands
            .send(if attention {
                Command::AttentionObserve {
                    request,
                    scope: 1,
                    active: true,
                }
            } else {
                Command::PaletteObserve {
                    request,
                    scope: 1,
                    active: true,
                    query: "fixture remote agent".into(),
                }
            })
            .unwrap();
        let state = until(bridge, |s| {
            let p = if attention {
                &s.attention_agents
            } else {
                &s.palette_agents
            };
            s.request == request
                && p.as_ref().is_some_and(|p| {
                    p.scope == 1
                        && p.roster
                            .rows
                            .iter()
                            .any(|r| r.name == "Fixture remote agent" && r.available)
                })
        });
        assert!(state.input_ready);
        assert_eq!(
            state.selected_pane,
            if attention {
                expected.clone()
            } else {
                local.selected_pane.clone()
            }
        );
        let publication = if attention {
            state.attention_agents
        } else {
            state.palette_agents
        }
        .unwrap();
        let row = publication
            .roster
            .rows
            .iter()
            .find(|r| r.name == "Fixture remote agent" && r.available)
            .unwrap();
        assert_eq!(row.machine_label.as_deref(), Some("Owned SSH fixture"));
        assert_eq!(row.pane_id, expected);
        bridge
            .commands
            .send(if attention {
                Command::OpenAttentionAgent {
                    request: request + 1,
                    from_request: request,
                    scope: 1,
                    roster_revision: publication.roster.revision,
                    key: row.key.clone(),
                }
            } else {
                Command::OpenPaletteAgent {
                    request: request + 1,
                    from_request: request,
                    scope: 1,
                    roster_revision: publication.roster.revision,
                    key: row.key.clone(),
                }
            })
            .unwrap();
        let opened = until(bridge, |s| s.request == request + 1 && s.input_ready);
        assert_eq!(opened.selected_pane, expected);
        assert_eq!(opened.selected_session.as_deref(), Some(session));
    }
    bridge.commands.send(Command::Home { request: 6 }).unwrap();
    let home = until(bridge, |s| {
        s.request == 6
            && s.home_phase == HomePhase::Live
            && s.fleet.as_ref().is_some_and(|f| {
                f.groups
                    .iter()
                    .any(|g| g.id == "local" && g.sessions.iter().any(|s| s.selection.is_some()))
            })
    });
    let selection = home
        .fleet
        .as_ref()
        .unwrap()
        .groups
        .iter()
        .find(|g| g.id == "local")
        .unwrap()
        .sessions
        .iter()
        .find_map(|s| s.selection.clone())
        .unwrap();
    bridge
        .commands
        .send(Command::FleetSession {
            request: 7,
            selection,
        })
        .unwrap();
    let local = until(bridge, |s| {
        s.request == 7
            && s.input_ready
            && s.workspace_fleet_agents.as_ref().is_some_and(|p| {
                p.roster
                    .rows
                    .iter()
                    .any(|r| r.name == "Fixture remote agent" && r.available)
            })
    });
    let publication = local.workspace_fleet_agents.as_ref().unwrap();
    let row = publication
        .roster
        .rows
        .iter()
        .find(|r| r.name == "Fixture remote agent" && r.available)
        .unwrap();
    assert_eq!(row.pane_id, expected);
    bridge
        .commands
        .send(Command::OpenWorkspaceFleetAgent {
            request: 8,
            from_request: 7,
            scope: publication.scope,
            roster_revision: publication.roster.revision,
            key: row.key.clone(),
        })
        .unwrap();
    let remote = until(bridge, |s| s.request == 8 && s.input_ready);
    assert_eq!(remote.selected_pane, expected);
    assert_eq!(remote.selected_session.as_deref(), Some(session));
    until(bridge, |s| {
        s.request == 8
            && s.session_tabs.as_ref().is_some_and(|tabs| {
                tabs.rows.iter().any(|row| {
                    Some(&row.id) == tabs.active.as_ref()
                        && matches!(
                            row.activity,
                            Some(crate::tmux_snapshot::session_tabs::Activity::Waiting)
                        )
                        && !row.unread
                })
            })
    });
    println!("NATIVE_REMOTE_TAB_ACTIVITY_VERIFIED");
    println!("NATIVE_REMOTE_WORKSPACE_AGENT_SELECTED");
    println!("NATIVE_REMOTE_PICKERS_SELECTED");
}
