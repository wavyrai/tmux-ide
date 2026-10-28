use super::*;
#[test]
#[ignore = "requires the explicit owned picker fixture"]
fn native_agent_pickers_select_across_workspaces() {
    assert_eq!(
        std::env::var("TMUX_IDE_NATIVE_TEST_AGENT_PICKERS").as_deref(),
        Ok("owned-pickers")
    );
    let record = std::env::var_os("TMUX_IDE_TEST_DAEMON_RECORD").unwrap();
    let (bridge, owner) = start(record.into(), Default::default()).unwrap();
    until(&bridge, |s| {
        s.home_phase == HomePhase::Live && s.palette_supported
    });
    let mut expected_attention_pane = None;
    let mut previous_pane = None;
    for request in 0..3 {
        let attention = request == 2;
        let scope = if attention { 1 } else { request + 1 };
        let name = if request == 1 {
            "Fixture recovery 0"
        } else {
            "Fixture native agent"
        };
        bridge
            .commands
            .send(if attention {
                Command::AttentionObserve {
                    request,
                    scope,
                    active: true,
                }
            } else {
                Command::PaletteObserve {
                    request,
                    scope,
                    active: true,
                    query: name.into(),
                }
            })
            .unwrap();
        let state = until(&bridge, |s| {
            let publication = if attention {
                &s.attention_agents
            } else {
                &s.palette_agents
            };
            s.request == request
                && publication.as_ref().is_some_and(|p| {
                    p.scope == scope && p.roster.rows.iter().any(|r| r.name == name && r.available)
                })
        });
        if request > 0 {
            assert!(state.input_ready);
            assert_eq!(state.selected_pane, previous_pane);
        }
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
            .find(|r| r.name == name && r.available)
            .unwrap();
        if request == 0 {
            expected_attention_pane = row.pane_id.clone();
        }
        if attention {
            assert_eq!(row.pane_id, expected_attention_pane);
        }
        let expected = row.pane_id.clone();
        bridge
            .commands
            .send(if attention {
                Command::OpenAttentionAgent {
                    request: request + 1,
                    from_request: request,
                    scope,
                    roster_revision: publication.roster.revision,
                    key: row.key.clone(),
                }
            } else {
                Command::OpenPaletteAgent {
                    request: request + 1,
                    from_request: request,
                    scope,
                    roster_revision: publication.roster.revision,
                    key: row.key.clone(),
                }
            })
            .unwrap();
        let opened = until(&bridge, |s| s.request == request + 1 && s.input_ready);
        assert_eq!(opened.selected_pane, expected);
        if request == 1 {
            assert_ne!(opened.selected_pane, expected_attention_pane);
        }
        previous_pane = opened.selected_pane;
    }
    let unread_tab = activity_live::complete_inactive(&bridge);
    let workspace = until(&bridge, |s| {
        s.request == 3
            && s.workspace_fleet_agents.as_ref().is_some_and(|p| {
                p.roster
                    .rows
                    .iter()
                    .any(|r| r.name == "Fixture recovery 0" && r.available)
                    && p.selected_key.is_some()
            })
    });
    let publication = workspace.workspace_fleet_agents.as_ref().unwrap();
    let selected = publication
        .roster
        .rows
        .iter()
        .find(|r| Some(&r.key) == publication.selected_key.as_ref())
        .unwrap();
    assert_eq!(selected.pane_id, expected_attention_pane);
    let row = publication
        .roster
        .rows
        .iter()
        .find(|r| r.name == "Fixture recovery 0" && r.available)
        .unwrap();
    let expected = row.pane_id.clone();
    bridge
        .commands
        .send(Command::OpenWorkspaceFleetAgent {
            request: 4,
            from_request: 3,
            scope: publication.scope + 1,
            roster_revision: publication.roster.revision,
            key: row.key.clone(),
        })
        .unwrap();
    let rejected = until(&bridge, |s| {
        s.workspace_fleet_agent_rejected
            .as_ref()
            .is_some_and(|r| r.request == 4)
    });
    assert_eq!(rejected.request, 3);
    assert_eq!(rejected.selected_pane, expected_attention_pane);
    // Take a current publication after the rejected attempt; observations can
    // legitimately advance while the terminal remains ready.
    let publication = rejected.workspace_fleet_agents.as_ref().unwrap();
    let row = publication
        .roster
        .rows
        .iter()
        .find(|r| r.name == "Fixture recovery 0" && r.available)
        .unwrap();
    bridge
        .commands
        .send(Command::OpenWorkspaceFleetAgent {
            request: 5,
            from_request: 3,
            scope: publication.scope,
            roster_revision: publication.roster.revision,
            key: row.key.clone(),
        })
        .unwrap();
    let opened = until(&bridge, |s| s.request == 5 && s.input_ready);
    assert_eq!(opened.selected_pane, expected);
    until(&bridge, |s| {
        s.request == 5
            && s.session_tabs.as_ref().is_some_and(|p| {
                p.active.as_ref() == Some(&unread_tab)
                    && p.rows.iter().any(|r| r.id == unread_tab && !r.unread)
            })
    });
    drop(bridge);
    owner.shutdown().unwrap();
}

#[path = "browser_native_local_tab_activity_live_tests.rs"]
mod activity_live;
