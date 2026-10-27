use super::*;
fn prepare(v: &mut SnapshotView) {
    v.browser_state.request = 7;
    v.browser_state.sessions.clear();
    v.browser_state.selected_session = None;
    v.browser_state.surface = browser::Surface::Workspace;
    v.browser_state.fleet =
        Some(serde_json::from_value(serde_json::json!({"groups":[],"omittedGroups":0})).unwrap());
    v.browser_state.workspace_fleet_agents=Some(serde_json::from_value(serde_json::json!({"request":7,"scope":2,"revision":3,"phase":"partial","selectedKey":"first","observedSessions":2,"totalSessions":4,"truncatedSessions":2,"truncatedRows":1,"note":"Default server observations only","rows":[
        {"key":"first","sessionId":"same-live-id","paneId":"same-pane-id","name":"Duplicate","sessionLabel":"Same","machineLabel":"Machine A","serverLabel":"Server A","status":"WORKING","attention":false,"available":true},
        {"key":"second","sessionId":"same-live-id","paneId":"same-pane-id","name":"Duplicate","sessionLabel":"Same","machineLabel":"Machine B","serverLabel":"Server B","status":"BLOCKED","attention":true,"available":true}
    ]})).unwrap());
}
#[gpui::test]
fn fleet_agent_keyboard_exact_cross_machine_target_rejection_preserves_terminal(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down enter");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::OpenWorkspaceFleetAgent{request:8,from_request:7,scope:2,roster_revision:3,key} if key=="second")
    );
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            assert!(v.frame.is_some());
            assert_eq!(v.browser_request, 7);
            let mut state = v.browser_state.clone();
            state.workspace_fleet_agent_rejected = v.workspace_fleet_agents.pending.clone();
            v.apply_browser_state(Some(state), cx);
            assert!(v.workspace_fleet_agents.pending.is_none());
            assert!(v.frame.is_some());
            assert_eq!(v.browser_request, 7);
            assert_eq!(v.next_navigation_request(), Some(9));
        })
    });
}
#[gpui::test]
fn fleet_agent_removed_before_enter_cannot_open_replacement(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down");
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            let p = v.browser_state.workspace_fleet_agents.as_mut().unwrap();
            p.scope = 3;
            p.roster.rows[1].key = "replacement".into();
        })
    });
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn fleet_agent_actual_pointer_and_coverage_use_authoritative_rows(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    view.read_with(cx, |v, _| {
        let all = rows(&v.browser_state);
        assert_eq!(
            all.iter()
                .filter(|r| r.agent.is_some() && r.selected)
                .count(),
            1
        );
        assert!(
            all.iter()
                .any(|r| r.label.contains("2 sessions · 1 agents omitted"))
        );
        assert!(
            all.iter()
                .any(|r| r.pane_count.as_deref() == Some("Machine B · Server B · Same"))
        );
    });
    let bounds = cx.debug_bounds("tmux-sidebar-row-4").unwrap();
    cx.simulate_click(bounds.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::OpenWorkspaceFleetAgent{key,..}if key=="second")
    );
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn fleet_agent_guards_unavailable_background_composition_and_full_queue(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            prepare(v);
            let target = Target::FleetAgent {
                scope: 2,
                revision: 3,
                key: "second".into(),
            };
            v.select_sidebar(7, &target, w, cx);
            assert!(v.workspace_fleet_agents.pending.is_none());
            assert!(v.frame.is_some());
            assert_eq!(v.browser_request, 7);
        })
    });
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            let target = Target::FleetAgent {
                scope: 2,
                revision: 3,
                key: "second".into(),
            };
            v.marked = "compose".into();
            v.select_sidebar(7, &target, w, cx);
            v.marked.clear();
            v.browser_state
                .workspace_fleet_agents
                .as_mut()
                .unwrap()
                .roster
                .phase = browser::home_agents::Phase::Unavailable;
            v.select_sidebar(7, &target, w, cx);
            v.browser_state
                .workspace_fleet_agents
                .as_mut()
                .unwrap()
                .roster
                .phase = browser::home_agents::Phase::Live;
            v.presence.set_active(false);
            v.select_sidebar(7, &target, w, cx);
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn fleet_agent_loading_acceptance_and_late_reply_cannot_replace_new_navigation(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down enter");
    receiver.try_recv().unwrap();
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let pending = v.workspace_fleet_agents.pending.clone().unwrap();
            let mut loading = v.browser_state.clone();
            loading.request = pending.request;
            loading.frame = None;
            loading.input_ready = false;
            loading.workspace_fleet_agents = None;
            v.apply_browser_state(Some(loading), cx);
            assert_eq!(v.browser_request, 8);
            assert!(v.frame.is_none());
            assert!(v.workspace_fleet_agents.pending.is_none());
            v.browser_request = 10;
            v.workspace_fleet_agents.pending = Some(pending);
            let mut late = v.browser_state.clone();
            late.request = 8;
            v.apply_browser_state(Some(late), cx);
            assert_eq!(v.browser_request, 10);
            assert!(v.workspace_fleet_agents.pending.is_none());
        })
    });
}

#[gpui::test]
fn fleet_agent_redraw_rebinds_same_key_revision_without_admitting_stale_enter(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down");
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            v.browser_state
                .workspace_fleet_agents
                .as_mut()
                .unwrap()
                .roster
                .revision = 4;
            let old = Target::FleetAgent {
                scope: 2,
                revision: 3,
                key: "second".into(),
            };
            v.select_sidebar(7, &old, w, cx);
            assert!(receiver.try_recv().is_err());
            v.reconcile_sidebar_keyboard(w, cx);
            assert_eq!(
                v.sidebar_keyboard.selected,
                Some(Target::FleetAgent {
                    scope: 2,
                    revision: 4,
                    key: "second".into()
                })
            );
        });
    });
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::OpenWorkspaceFleetAgent {roster_revision: 4, key, ..} if key == "second")
    );
}

#[gpui::test]
fn fleet_agent_redraw_does_not_rebind_removed_unavailable_or_new_scope(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    for change in 0..3 {
        cx.update(|w, cx| {
            view.update(cx, |v, _| prepare(v));
            w.draw(cx).clear(cx);
        });
        receiver.try_iter().for_each(drop);
        cx.simulate_keystrokes("ctrl-g down");
        cx.update(|w, cx| {
            view.update(cx, |v, cx| {
                let publication = v.browser_state.workspace_fleet_agents.as_mut().unwrap();
                publication.roster.revision += 1;
                match change {
                    0 => {
                        publication.roster.rows.remove(1);
                    }
                    1 => publication.roster.rows[1].available = false,
                    _ => publication.scope += 1,
                }
                v.reconcile_sidebar_keyboard(w, cx);
                assert!(v.sidebar_keyboard.selected.is_none());
            })
        });
        cx.simulate_keystrokes("enter");
        assert!(receiver.try_recv().is_err());
    }
}
