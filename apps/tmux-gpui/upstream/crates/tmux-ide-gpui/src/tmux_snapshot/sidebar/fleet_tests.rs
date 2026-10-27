use super::*;
pub(super) fn fleet() -> browser::fleet::Fleet {
    serde_json::from_value(serde_json::json!({"preferences":{"revision":3,"phase":"ready","error":null},"omittedGroups":0,"groups":[{
 "id":"machine","label":"Duplicate","state":"ready","conflict":false,"collapsed":false,"collapseAction":"11111111-1111-4111-8111-111111111111","omittedSessions":0,"omittedServers":0,
 "servers":[{"id":"server-a","label":"Duplicate","state":"online","generation":"22222222-2222-4222-8222-222222222222","selection":"33333333-3333-4333-8333-333333333333"},{"id":"server-b","label":"Duplicate","state":"online","generation":"44444444-4444-4444-8444-444444444444","selection":"55555555-5555-4555-8555-555555555555"},{"id":"empty","label":"Empty","state":"offline","generation":null,"selection":null}],
 "sessions":[{"id":"canonical-a","name":"Duplicate","sessionId":"session-a","serverId":"server-a","paneCount":1,"selection":"66666666-6666-4666-8666-666666666666","active":true},
 {"id":"canonical-b","name":"Duplicate","sessionId":"session-b","serverId":"server-b","paneCount":2,"selection":"77777777-7777-4777-8777-777777777777","favorite":true,"favoriteAction":"88888888-8888-4888-8888-888888888888"},
 {"id":"ordinary","name":"Other","sessionId":"session-c","serverId":"server-b","paneCount":1,"selection":"99999999-9999-4999-8999-999999999999"},
 {"id":"unscoped","name":"Unscoped","sessionId":"session-d","serverId":null,"paneCount":1,"selection":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]}]})).unwrap()
}
#[test]
fn hierarchy_preserves_exact_routes_and_collapse_exceptions() {
    let mut state = browser::State {
        fleet: Some(fleet()),
        selected_session: Some("session-a".into()),
        ..Default::default()
    };
    let projected = rows(&state);
    assert_eq!(projected.iter().filter(|r| r.selected).count(), 1);
    assert!(
        projected
            .iter()
            .any(|r| r.label == "Empty" && r.target.is_none())
    );
    assert!(projected.iter().any(|r| r.label == "Other sessions"));
    let target = projected
        .iter()
        .filter_map(|r| r.target.clone())
        .find(|t| matches!(t,Target::FleetSession{id,..}if id=="canonical-b"))
        .unwrap();
    assert!(current(&state, &target));
    state.fleet.as_mut().unwrap().groups[0].servers[1].generation =
        Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into());
    assert!(!current(&state, &target));
    state.fleet.as_mut().unwrap().groups[0].collapsed = true;
    let collapsed = rows(&state);
    assert!(
        !collapsed
            .iter()
            .any(|r| r.label == "Empty" || r.label == "Other" || r.label == "Unscoped")
    );
    assert_eq!(
        collapsed
            .iter()
            .filter(|r| matches!(&r.target, Some(Target::FleetSession { .. })))
            .count(),
        2
    );
    state.fleet.as_mut().unwrap().groups[0].conflict = true;
    assert!(!rows(&state).iter().any(|r| matches!(
        &r.target,
        Some(Target::FleetSession { .. } | Target::FleetServer { .. })
    )));
}
#[gpui::test]
fn workspace_hierarchy_keyboard_exact_second_route_and_stale_removal(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            v.browser_state.request = 7;
            v.browser_state.fleet = Some(fleet());
        });
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down down enter");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::FleetSession{request:8,selection}if selection=="77777777-7777-4777-8777-777777777777")
    );
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn collapse_and_favorite_do_not_navigate_or_rearm_workspace(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            v.browser_state.request = 7;
            v.browser_state.fleet = Some(fleet());
            v.input_interrupted = true;
        });
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g home left");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetPreference {
            request: 7,
            revision: 3,
            enabled: true,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| {
        assert_eq!(v.browser_request, 7);
        assert!(v.input_interrupted);
    });
    cx.simulate_keystrokes("left");
    assert!(receiver.try_recv().is_err());
}
#[test]
fn duplicate_live_session_ids_on_other_machine_do_not_duplicate_active_highlight() {
    let mut f = fleet();
    let mut other = f.groups[0].clone();
    other.id = "other-machine".into();
    for s in &mut other.sessions {
        s.active = false;
    }
    f.groups.push(other);
    let state = browser::State {
        fleet: Some(f),
        selected_session: Some("session-a".into()),
        ..Default::default()
    };
    assert_eq!(rows(&state).iter().filter(|r| r.selected).count(), 1);
}
#[gpui::test]
fn removed_displayed_fleet_session_enter_does_not_select_replacement(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            v.browser_state.request = 7;
            v.browser_state.fleet = Some(fleet());
        });
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g down down");
    cx.update(|_, cx| {
        view.update(cx, |v, _| {
            v.browser_state.fleet.as_mut().unwrap().groups[0].sessions[1].selection =
                Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into());
        })
    });
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn workspace_favorite_pointer_isolated_from_session_navigation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            v.browser_state.request = 7;
            v.browser_state.fleet = Some(fleet());
            v.input_interrupted = true;
        });
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let bounds = cx.debug_bounds("sidebar-favorite-4").unwrap();
    cx.simulate_click(bounds.center(), Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetPreference {
            request: 7,
            revision: 3,
            enabled: false,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| {
        assert_eq!(v.browser_request, 7);
        assert!(v.input_interrupted);
    });
}
#[test]
fn missing_fleet_coverage_keeps_current_catalog_without_cross_machine_id_dedup() {
    let mut state = browser::State {
        fleet: Some(fleet()),
        sessions: vec![choice("session-a", "Current"), choice("missing", "Missing")],
        ..Default::default()
    };
    assert!(
        !rows(&state)
            .iter()
            .any(|r| r.target == Some(Target::Session("session-a".into())))
    );
    assert!(
        rows(&state)
            .iter()
            .any(|r| r.target == Some(Target::Session("missing".into())))
    );
    state.fleet.as_mut().unwrap().groups[0].sessions[0].server_id = None;
    assert!(
        rows(&state)
            .iter()
            .any(|r| r.target == Some(Target::Session("session-a".into())))
    );
    state.fleet.as_mut().unwrap().groups.clear();
    assert_eq!(
        rows(&state)
            .iter()
            .filter(|r| matches!(&r.target, Some(Target::Session(_))))
            .count(),
        2
    );
}
#[gpui::test]
fn child_left_collapses_parent_and_redraw_preserves_machine_focus(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            v.browser_state.fleet = Some(fleet());
        });
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-g left");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetPreference { enabled: true, .. }
    ));
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            let f = v.browser_state.fleet.as_mut().unwrap();
            f.preferences.as_mut().unwrap().phase = browser::fleet::PreferencePhase::Saving;
            f.groups[0].collapse_action = None;
        });
        w.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("enter right");
    assert!(receiver.try_recv().is_err());
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            let f = v.browser_state.fleet.as_mut().unwrap();
            f.preferences.as_mut().unwrap().phase = browser::fleet::PreferencePhase::Ready;
            f.preferences.as_mut().unwrap().revision = 4;
            f.groups[0].collapsed = true;
            f.groups[0].collapse_action = Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into());
        });
        w.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("right");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::FleetPreference {
            revision: 4,
            enabled: false,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn sidebar_stale_publication_and_full_preference_queue_preserve_workspace(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    // Constructor presence deliberately occupies the single queue slot.
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet = Some(fleet());
            v.prepare_home_filter(cx);
            let target = rows(&v.browser_state)[0].target.clone().unwrap();
            v.browser_state.request = 6;
            v.select_sidebar(7, &target, w, cx);
            assert_eq!(v.browser_request, 7);
            v.browser_state.request = 7;
            v.select_sidebar(7, &target, w, cx);
            assert_eq!(v.browser_request, 7);
            assert!(v.frame.is_some());
            assert!(v.fleet_preference_status().is_some());
        });
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Presence { .. }
    ));
    assert!(receiver.try_recv().is_err());
}
