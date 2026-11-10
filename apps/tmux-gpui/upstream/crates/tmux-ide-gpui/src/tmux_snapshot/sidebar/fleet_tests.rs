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
fn projects_are_headings_with_exact_routes_and_machines_stay_on_home() {
    let mut state = browser::State {
        fleet: Some(fleet()),
        selected_session: Some("session-a".into()),
        ..Default::default()
    };
    let projected = rows(&state);
    assert_eq!(projected.iter().filter(|r| r.selected).count(), 1);
    // No machine, server or "Other sessions" rows (#746); an offline server
    // is one quiet line.
    assert!(projected.iter().all(|r| r.machine.is_none()));
    assert!(!projected.iter().any(|r| r.label == "Other sessions"));
    assert!(
        projected
            .iter()
            .any(|r| r.label == "1 server offline" && r.target.is_none())
    );
    // Favourites first, then by name; every session is a heading.
    let headings: Vec<_> = projected
        .iter()
        .filter(|r| r.kind == Kind::Heading)
        .map(|r| r.label.as_str())
        .collect();
    assert_eq!(headings, ["Duplicate", "Duplicate", "Other", "Unscoped"]);
    let target = projected
        .iter()
        .filter_map(|r| r.target.clone())
        .find(|t| matches!(t,Target::FleetSession{id,..}if id=="canonical-b"))
        .unwrap();
    assert_eq!(projected[0].target.as_ref(), Some(&target));
    assert!(current(&state, &target));
    state.fleet.as_mut().unwrap().groups[0].servers[1].generation =
        Some("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into());
    assert!(!current(&state, &target));
    // Collapsing a machine is Home's; the sidebar still lists every project.
    state.fleet.as_mut().unwrap().groups[0].collapsed = true;
    assert_eq!(
        rows(&state)
            .iter()
            .filter(|r| matches!(&r.target, Some(Target::FleetSession { .. })))
            .count(),
        4
    );
    state.fleet.as_mut().unwrap().groups[0].conflict = true;
    let conflicted = rows(&state);
    assert!(
        !conflicted
            .iter()
            .any(|r| matches!(&r.target, Some(Target::FleetSession { .. })))
    );
    assert!(
        conflicted
            .iter()
            .any(|r| r.aside.as_deref() == Some("Identity conflict"))
    );
}
#[test]
fn a_remote_project_names_its_machine_only_when_there_are_several() {
    let mut f = fleet();
    let state = browser::State {
        fleet: Some(f.clone()),
        ..Default::default()
    };
    assert!(rows(&state).iter().all(|r| r.aside.is_none()));
    let mut other = f.groups[0].clone();
    other.id = "spark".into();
    other.label = "spark".into();
    for s in &mut other.sessions {
        s.active = false;
    }
    f.groups.push(other);
    let state = browser::State {
        fleet: Some(f),
        ..Default::default()
    };
    let asides: Vec<_> = rows(&state)
        .into_iter()
        .filter(|r| r.kind == Kind::Heading)
        .map(|r| r.aside)
        .collect();
    assert!(asides.contains(&Some("spark".into())));
    assert!(asides.contains(&Some("Duplicate".into())));
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
    // The open project leads with its pane (#746); the favourite follows.
    cx.simulate_keystrokes("ctrl-g home down down enter");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::FleetSession{request:8,selection}if selection=="77777777-7777-4777-8777-777777777777")
    );
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn arrows_are_inert_and_f_toggles_the_star_without_navigating(cx: &mut TestAppContext) {
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
    cx.simulate_keystrokes("ctrl-g home down down left right");
    assert!(receiver.try_recv().is_err(), "no machine to collapse here");
    cx.simulate_keystrokes("f");
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
    cx.simulate_keystrokes("ctrl-g home down down");
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
    // Row 2: the favourite, after the open project and its pane (#746).
    let bounds = cx.debug_bounds("sidebar-favorite-2").unwrap();
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
fn sidebar_stale_publication_and_full_preference_queue_preserve_workspace(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    // Constructor presence deliberately occupies the single queue slot.
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.fleet = Some(fleet());
            v.prepare_home_filter(cx);
            // The first star with an action: machines' collapse controls are
            // Home's.
            let (action, favorite) = rows(&v.browser_state)
                .into_iter()
                .find_map(|r| r.favorite.filter(|(action, _)| action.is_some()))
                .unwrap();
            let action = action.unwrap();
            v.browser_state.request = 6;
            v.change_fleet_preference(7, 3, &action, !favorite, cx);
            assert_eq!(v.browser_request, 7);
            v.browser_state.request = 7;
            v.change_fleet_preference(7, 3, &action, !favorite, cx);
            let _ = w;
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
#[test]
fn hierarchy_omitted_counts_use_singular_only_for_one() {
    for (sessions, servers, machines, group_line, fleet_line) in [
        (
            1,
            2,
            1,
            "1 session · 2 servers omitted",
            "1 machine omitted",
        ),
        (
            2,
            1,
            2,
            "2 sessions · 1 server omitted",
            "2 machines omitted",
        ),
    ] {
        let mut fleet = fleet();
        fleet.omitted_groups = machines;
        fleet.groups[0].omitted_sessions = sessions;
        fleet.groups[0].omitted_servers = servers;
        let state = browser::State {
            fleet: Some(fleet),
            ..Default::default()
        };
        let labels: Vec<_> = rows(&state).into_iter().map(|r| r.label).collect();
        assert!(labels.iter().any(|l| l == group_line), "{labels:?}");
        assert!(labels.iter().any(|l| l == fleet_line), "{labels:?}");
    }
}
#[test]
fn the_open_project_leads_and_this_macs_projects_name_no_machine() {
    let mut f = fleet();
    f.groups[0].id = "local".into();
    f.groups[0].label = "Local".into();
    let mut other = f.groups[0].clone();
    other.id = "spark".into();
    other.label = "spark".into();
    for s in &mut other.sessions {
        s.active = false;
        s.session_id = s.session_id.as_ref().map(|id| format!("{id}-spark"));
    }
    // The open project is on spark, after the whole of Local.
    other.sessions[3].active = true;
    for s in &mut f.groups[0].sessions {
        s.active = false;
    }
    f.groups.push(other);
    let state = browser::State {
        fleet: Some(f),
        surface: browser::Surface::Workspace,
        selected_session: Some("session-d-spark".into()),
        ..Default::default()
    };
    let headings: Vec<_> = rows(&state)
        .into_iter()
        .filter(|r| r.kind == Kind::Heading)
        .map(|r| (r.label, r.aside))
        .collect();
    // Open project first (#746, card 12 option C), then each machine's
    // favourites, then by name; only spark's projects name their machine.
    assert_eq!(headings[0], ("Unscoped".into(), Some("spark".into())));
    assert_eq!(headings[1], ("Duplicate".into(), None));
    assert_eq!(headings.len(), 8);
    assert_eq!(
        headings
            .iter()
            .filter(|(label, _)| label == "Unscoped")
            .count(),
        2
    );
}

/// r4: a remote machine being retried lists its sessions as away, muted.
#[test]
fn an_away_machines_rows_are_marked_away() {
    let mut fleet: browser::fleet::Fleet = serde_json::from_value(serde_json::json!({
        "groups": [
            {"id": "local", "label": "local", "state": "ready", "conflict": false,
             "omittedSessions": 0, "sessions": [
                {"id": "local-web", "name": "web", "paneCount": 1, "sessionId": "live-local-web"}]},
            {"id": "spark", "label": "spark", "state": "disconnected", "conflict": false,
             "omittedSessions": 0, "sessions": [
                {"id": "spark-api", "name": "api", "paneCount": 2, "sessionId": "live-spark-api"}]}
        ],
        "omittedGroups": 0,
        "preferences": {"revision": 1, "phase": "ready", "error": null}
    }))
    .unwrap();
    fleet.groups[1].away = Some((std::time::Instant::now(), std::time::SystemTime::now()));
    let state = browser::State::default();
    let at = fleet.groups[1].away.unwrap().0;
    // Under the slot's 8 s it reads as before: no tag, not muted.
    let quiet = hierarchy::rows(&state, &fleet, at + std::time::Duration::from_secs(3));
    let api = quiet.iter().find(|r| r.label == "api").unwrap();
    assert!(!api.away);
    assert_eq!(api.aside.as_deref(), Some("spark"));
    assert!(
        !quiet
            .iter()
            .any(|r| r.aside.as_deref() == Some("Reconnecting…"))
    );
    let rows = hierarchy::rows(&state, &fleet, at + std::time::Duration::from_secs(9));
    assert!(
        rows.iter()
            .any(|r| r.aside.as_deref() == Some("Reconnecting…"))
    );
    let api = rows.iter().find(|r| r.label == "api").unwrap();
    assert!(api.away);
    assert_eq!(api.aside.as_deref(), Some("spark · away"));
    let web = rows.iter().find(|r| r.label == "web").unwrap();
    assert!(!web.away);
}
