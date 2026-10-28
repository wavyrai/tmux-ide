use super::*;
fn fleet() -> browser::fleet::Fleet {
    serde_json::from_value(serde_json::json!({"groups":[{"id":"local","label":"Local","state":"ready","conflict":false,"omittedSessions":0,"sessions":[],"servers":[{"id":"server-a","label":"Duplicate","state":"online","generation":"11111111-1111-4111-8111-111111111111","selection":"22222222-2222-4222-8222-222222222222"},{"id":"server-b","label":"Duplicate","state":"online","generation":"33333333-3333-4333-8333-333333333333","selection":"44444444-4444-4444-8444-444444444444"},{"id":"offline","label":"Offline","state":"offline","generation":null,"selection":null}]}],"omittedGroups":0})).unwrap()
}
#[gpui::test]
fn empty_server_selection_queues_exact_route_without_pane_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.request = 7;
            view.browser_state.fleet = Some(fleet());
            view.input_interrupted = true;
            view.open_commands(window, cx);
            let targets = command_rows(&view.browser_state, "Duplicate");
            assert_eq!(targets.len(), 2);
            view.choose_picker(targets[1].target.clone(), window, cx);
            assert_eq!(view.browser_request, 8);
            assert!(view.browser_state.surface == browser::Surface::Home);
            assert!(view.browser_state.selected_pane.is_none());
            assert!(view.pending_session_open.is_none());
            assert!(view.browser_state.create_session.is_none());
            assert!(view.input_interrupted);
        })
    });
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"fleet-server","request":8,"selection":"44444444-4444-4444-8444-444444444444"})
    );
    assert!(receiver.try_recv().is_err());
}
#[test]
fn server_rows_keep_offline_visible_and_reject_retired_tokens() {
    let mut state = browser::State {
        fleet: Some(fleet()),
        ..Default::default()
    };
    let offline_rows = rows(&state, "Offline");
    assert_eq!(offline_rows.len(), 1);
    assert!(!current(&state, &offline_rows[0].target));
    let target = rows(&state, "Duplicate")[0].target.clone();
    assert!(current(&state, &target));
    state.fleet.as_mut().unwrap().groups[0].servers.clear();
    assert!(!current(&state, &target));
}

#[gpui::test]
fn home_server_hierarchy_keeps_unscoped_sessions_visible(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window,cx| {
        let mut view=make_view(window,cx,sender);
        view.browser_state.surface=browser::Surface::Home;
        view.browser_state.request=7;
        let value=serde_json::json!({"id":"unscoped","name":"Unscoped session","paneCount":1,"sessionId":"session-a","selection":"55555555-5555-4555-8555-555555555555","serverId":null});
        let mut state=fleet();
        state.groups[0].sessions.push(serde_json::from_value(value).unwrap());
        view.browser_state.fleet=Some(state);
        view.frame=None;
        view
    });
    cx.simulate_resize(size(px(640.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    assert!(cx.debug_bounds("fleet-server-0-0").is_some());
    assert!(cx.debug_bounds("fleet-server-0-2").is_some());
    let unscoped = cx.debug_bounds("fleet-session-0-0").unwrap();
    cx.simulate_click(unscoped.center(), Modifiers::default());
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"fleet-session","request":8,"selection":"55555555-5555-4555-8555-555555555555"})
    );
    assert!(receiver.try_recv().is_err());
    assert!(view.read_with(cx, |view, _| view.pending_session_open.is_some()));
}

#[test]
fn session_search_labels_include_exact_published_server() {
    let mut fleet = fleet();
    fleet.groups[0].servers[0].label = "First server".into();
    fleet.groups[0].servers[1].label = "Second server".into();
    for (id, server, token) in [
        ("one", "server-a", "55555555-5555-4555-8555-555555555555"),
        ("two", "server-b", "66666666-6666-4666-8666-666666666666"),
    ] {
        fleet.groups[0].sessions.push(serde_json::from_value(serde_json::json!({"id":id,"name":"Same session","paneCount":1,"sessionId":id,"selection":token,"serverId":server})).unwrap());
    }
    let state = browser::State {
        fleet: Some(fleet),
        ..Default::default()
    };
    let matches = rows(&state, "Second server Same session");
    assert_eq!(matches.len(), 1);
    assert!(
        matches!(&matches[0].target, Target::FleetSession { selection, session_id } if selection == "66666666-6666-4666-8666-666666666666" && session_id == "two")
    );
}
