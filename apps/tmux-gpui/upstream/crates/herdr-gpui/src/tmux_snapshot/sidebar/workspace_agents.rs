use super::*;
fn workspace_roster() -> browser::home_agents::WorkspaceRoster {
    serde_json::from_value(serde_json::json!({"sessionId":"session-a","revision":4,"phase":"live","rows":[{"key":"agent-a","sessionId":"session-a","paneId":"pane-a","name":"Same long agent name repeated across rows","sessionLabel":"Same","status":"WORKING","attention":false,"available":true},{"key":"agent-b","sessionId":"session-a","paneId":"pane-b","name":"Same long agent name repeated across rows","sessionLabel":"Same","status":"IDLE","attention":false,"available":true}],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap()
}
#[gpui::test]
fn workspace_agent_rendered_duplicate_labels_open_exact_key(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        // The fresh authoritative roster may include a pane absent from initial choices.
        assert!(!view.browser_state.panes.iter().any(|p| p.id == "pane-b"));
        view.browser_state.workspace_agents = Some(workspace_roster());
        view
    });
    cx.simulate_resize(size(px(640.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let row = cx.debug_bounds("tmux-workspace-agent-1").unwrap();
    assert!(row.size.width <= px(224.));
    receiver.try_iter().for_each(drop);
    cx.simulate_click(row.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::OpenWorkspaceAgent {request:8,from_request:7,roster_revision:4,key,session_id} if key=="agent-b" && session_id=="session-a")
    );
    view.read_with(cx, |view, _| {
        assert!(view.frame.is_none());
        assert!(!view.browser_state.input_ready);
    });
}
#[gpui::test]
fn workspace_agent_stale_scope_and_unavailable_actions_leave_terminal_unchanged(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.workspace_agents = Some(workspace_roster());
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let frame = view.frame.clone().unwrap();
            view.workspace_agent_select(7, 3, "session-a", "agent-a", window, cx);
            view.workspace_agent_select(7, 4, "session-b", "agent-a", window, cx);
            view.browser_state
                .workspace_agents
                .as_mut()
                .unwrap()
                .roster
                .rows[0]
                .available = false;
            view.workspace_agent_select(7, 4, "session-a", "agent-a", window, cx);
            view.browser_state
                .workspace_agents
                .as_mut()
                .unwrap()
                .roster
                .rows[0]
                .available = true;
            view.browser_state.surface = browser::Surface::Home;
            view.workspace_agent_select(7, 4, "session-a", "agent-a", window, cx);
            assert_eq!(view.browser_request, 7);
            assert!(Arc::ptr_eq(&frame, view.frame.as_ref().unwrap()));
            assert!(view.browser_state.input_ready);
        })
    });
    assert!(receiver.try_recv().is_err());
}
#[test]
fn workspace_roster_scope_and_wire_are_strict() {
    let mut roster = workspace_roster();
    assert!(roster.valid());
    roster.roster.rows[0].session_id = "other-session".into();
    assert!(!roster.valid());
    assert_eq!(
        serde_json::to_value(browser::Command::OpenWorkspaceAgent {
            request: 8,
            from_request: 7,
            roster_revision: 4,
            key: "agent-b".into(),
            session_id: "session-a".into()
        })
        .unwrap(),
        serde_json::json!({"type":"open-workspace-agent","request":8,"fromRequest":7,"rosterRevision":4,"key":"agent-b","sessionId":"session-a"})
    );
}

#[gpui::test]
fn long_workspace_roster_keeps_last_row_in_scrollable_content(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        let mut roster = workspace_roster();
        let original = roster.roster.rows[0].clone();
        roster.roster.rows = (0..40)
            .map(|i| {
                let mut row = original.clone();
                row.key = format!("agent-{i}");
                row
            })
            .collect();
        view.browser_state.workspace_agents = Some(roster);
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let last = cx.debug_bounds("tmux-workspace-agent-39").unwrap();
    let section = cx.debug_bounds("tmux-workspace-agents-section").unwrap();
    assert!(
        last.bottom() <= section.bottom(),
        "last row {last:?} escapes clipped section {section:?}"
    );
    receiver.try_iter().for_each(drop);
    for _ in 0..10 {
        cx.simulate_event(ScrollWheelEvent {
            position: point(px(100.), px(200.)),
            delta: ScrollDelta::Pixels(point(px(0.), px(-300.))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
    let last = cx.debug_bounds("tmux-workspace-agent-39").unwrap();
    assert!(
        last.top() >= px(0.) && last.bottom() <= px(400.),
        "last agent must be reachable: {last:?}"
    );
    assert!(
        receiver.try_recv().is_err(),
        "sidebar scrolling must not send terminal input"
    );
}
