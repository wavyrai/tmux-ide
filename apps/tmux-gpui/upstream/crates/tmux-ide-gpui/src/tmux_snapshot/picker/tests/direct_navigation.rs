use super::*;
fn roster() -> browser::home_agents::Roster {
    serde_json::from_value(serde_json::json!({"revision":3,"phase":"live","rows":[
        {"key":"first","sessionId":"session-a","paneId":"pane-a","name":"Same agent","sessionLabel":"Alpha","status":"IDLE","attention":false,"available":true},
        {"key":"second","sessionId":"session-b","paneId":"pane-b","name":"Same agent","sessionLabel":"Beta","status":"IDLE","attention":false,"available":true}
    ],"observedSessions":2,"totalSessions":2,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap()
}
#[test]
fn direct_rows_filter_before_cap_and_preserve_duplicate_identity() {
    let mut state = browser::State {
        request: 7,
        surface: browser::Surface::Home,
        home_agents: Some(roster()),
        ..Default::default()
    };
    state.sessions = (0..80)
        .map(|i| choice(&format!("s{i}"), &format!("Session {i}")))
        .collect();
    assert_eq!(navigation_commands::rows(&state, "").len(), 32);
    let rows = navigation_commands::rows(&state, "agent beta");
    assert_eq!(rows.len(), 1);
    let Target::DirectNavigation(target) = &rows[0].target else {
        panic!("direct target")
    };
    assert!(target.current(&state));
    state.home_agents.as_mut().unwrap().revision += 1;
    assert!(!target.current(&state));
    assert_eq!(navigation_commands::rows(&state, "session 79").len(), 1);
}
#[gpui::test]
fn f5_dispatched_search_opens_exact_duplicate_agent_without_terminal_input(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.request = 7;
            v.browser_state.surface = browser::Surface::Home;
            v.browser_state.home_agents = Some(roster());
            v.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.picker
                .as_ref()
                .unwrap()
                .search
                .update(cx, |search, cx| search.set_text_selected("agent beta", cx));
            v.refresh_picker(cx);
        })
    });
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::OpenAgent {request:8,from_request:7,roster_revision:3,key} if key=="second")
    );
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| assert!(v.input_interrupted));
}
#[gpui::test]
fn retained_f5_navigation_refuses_modal_request_roster_presence_and_marked_text(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.surface = browser::Surface::Home;
            v.browser_state.home_agents = Some(roster());
            v.open_commands(window, cx);
            let target = v
                .picker
                .as_ref()
                .unwrap()
                .rows
                .iter()
                .find(|r| r.label.contains("Beta"))
                .unwrap()
                .target
                .clone();
            v.open_picker_mode(Mode::Navigation, window, cx);
            v.choose_picker(target.clone(), window, cx);
            assert!(receiver.try_recv().is_err());
            v.open_commands(window, cx);
            let target = v
                .picker
                .as_ref()
                .unwrap()
                .rows
                .iter()
                .find(|r| r.label.contains("Beta"))
                .unwrap()
                .target
                .clone();
            v.marked = "composing".into();
            v.choose_picker(target.clone(), window, cx);
            assert!(receiver.try_recv().is_err());
            v.marked.clear();
            v.browser_state.home_agents.as_mut().unwrap().revision = 4;
            v.choose_picker(target.clone(), window, cx);
            assert!(receiver.try_recv().is_err());
            v.browser_state.home_agents.as_mut().unwrap().revision = 3;
            v.browser_state.request = 8;
            v.choose_picker(target.clone(), window, cx);
            assert!(receiver.try_recv().is_err());
            v.browser_state.request = 7;
            v.presence = Presence::new(false);
            v.choose_picker(target, window, cx);
            assert!(receiver.try_recv().is_err());
            assert!(v.picker.is_some());
        })
    });
}
#[gpui::test]
fn f5_session_row_reuses_exact_session_owner(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window,cx|view.update(cx,|v,cx|{
        v.browser_state.request=7;v.browser_state.sessions=vec![choice("one","Duplicate"),choice("two","Duplicate")];v.open_commands(window,cx);
        let targets: Vec<_> = v.picker.as_ref().unwrap().rows.iter().filter(|r| r.label.contains("Open session")).collect();assert_eq!(targets.len(),2);
        v.choose_picker(targets[1].target.clone(),window,cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Session {request:8,id} if id=="two"));assert!(receiver.try_recv().is_err());
    }));
}
#[gpui::test]
fn workspace_agent_uses_exact_scope_and_reopened_commands_reject_old_rows(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |v, cx| {
        v.browser_state.request = 7;
        v.browser_state.surface = browser::Surface::Workspace;
        v.browser_state.selected_session = Some("session-a".into());
        let mut value = serde_json::to_value(serde_json::json!({"revision":3,"phase":"live","rows":[],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap();
        value["sessionId"] = "session-a".into();
        v.browser_state.workspace_agents = Some(serde_json::from_value(value).unwrap());
        v.browser_state.workspace_agents.as_mut().unwrap().roster = roster();
            for row in &mut v.browser_state.workspace_agents.as_mut().unwrap().roster.rows { row.session_id = "session-a".into(); }
        v.browser_state.workspace_agents.as_mut().unwrap().roster.rows[1].project_name = Some("Project Zebra".into());
        assert!(v.browser_state.workspace_agents.as_ref().unwrap().valid());
        assert_eq!(navigation_commands::rows(&v.browser_state, "agent zebra").len(), 1);
        v.open_commands(window, cx);
        let capture = |v: &SnapshotView| v.picker.as_ref().unwrap().rows.iter().find(|r| r.label.contains("Beta")).unwrap().target.clone();
        let old = capture(v);
        v.close_picker(window, cx);
        v.open_commands(window, cx);
        v.choose_picker(old, window, cx);
        assert!(receiver.try_recv().is_err());
        let target = capture(v);
        v.browser_state.selected_session = Some("other".into());
        v.choose_picker(target.clone(), window, cx);
        v.browser_state.selected_session = Some("session-a".into());
        v.browser_state.workspace_agents.as_mut().unwrap().roster.phase = browser::home_agents::Phase::Unavailable;
        v.choose_picker(target.clone(), window, cx);
        v.browser_state.workspace_agents.as_mut().unwrap().roster.phase = browser::home_agents::Phase::Live;
        v.browser_state.workspace_agents.as_mut().unwrap().roster.revision = 4;
        v.choose_picker(target, window, cx);
        assert!(receiver.try_recv().is_err());
        v.refresh_picker(cx);
        v.choose_picker(capture(v), window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::OpenWorkspaceAgent {request:8, from_request:7, roster_revision:4, key, session_id} if key=="second" && session_id=="session-a"));
        assert!(receiver.try_recv().is_err());
    }));
}
#[test]
fn direct_sessions_disambiguate_published_server_names() {
    let fleet = serde_json::from_value(serde_json::json!({"groups":[{"id":"machine","label":"Same machine","state":"ready","conflict":false,"omittedSessions":0,"servers":[{"id":"a","label":"First server","state":"online","generation":null,"selection":null},{"id":"b","label":"Second server","state":"online","generation":null,"selection":null}],"sessions":[{"id":"one","name":"Duplicate","paneCount":1,"sessionId":"one","selection":"token-one","serverId":"a"},{"id":"two","name":"Duplicate","paneCount":1,"sessionId":"two","selection":"token-two","serverId":"b"}]}],"omittedGroups":0})).unwrap();
    let state = browser::State {
        fleet: Some(fleet),
        ..Default::default()
    };
    let rows = navigation_commands::rows(&state, "duplicate second");
    assert_eq!(rows.len(), 1);
    assert!(rows[0].label.contains("Second server"));
    let Target::DirectNavigation(target) = &rows[0].target else {
        panic!("direct session")
    };
    assert!(target.current(&state));
}
