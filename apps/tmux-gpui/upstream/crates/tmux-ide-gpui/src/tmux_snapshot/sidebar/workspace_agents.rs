use super::*;
fn workspace_roster() -> browser::home_agents::WorkspaceRoster {
    serde_json::from_value(serde_json::json!({"sessionId":"session-a","revision":4,"phase":"live","rows":[{"key":"agent-a","sessionId":"session-a","paneId":"pane-a","name":"Same long agent name repeated across rows","sessionLabel":"Same","status":"WORKING","attention":false,"available":true},{"key":"agent-b","sessionId":"session-a","paneId":"pane-b","name":"Same long agent name repeated across rows","sessionLabel":"Same","status":"IDLE","attention":false,"available":true}],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap()
}
#[gpui::test]
fn agent_pane_rows_show_the_agent_and_open_the_exact_pane(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.panes = vec![choice("pane-a", "Editor"), choice("pane-b", "Editor")];
        view.browser_state.workspace_agents = Some(workspace_roster());
        view
    });
    cx.simulate_resize(size(px(640.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // Both agent panes are rows, labelled with the agent's name since neither
    // pane has a title of its own (#746); the Agents section is gone.
    assert!(cx.debug_bounds("tmux-workspace-agents-section").is_none());
    let rows: Vec<_> = view.read_with(cx, |v, _| rows(&v.browser_state));
    let labels: Vec<_> = rows
        .iter()
        .filter(|r| r.pane.is_some())
        .map(|r| r.label.as_str())
        .collect();
    assert_eq!(labels, ["Same long agent name repeated across rows"; 2]);
    let row = cx.debug_bounds("tmux-sidebar-pane:pane-b").unwrap();
    assert!(row.size.width <= px(224.));
    receiver.try_iter().for_each(drop);
    cx.simulate_click(row.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane { request: 8, id } if id == "pane-b")
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
            assert!(frame.same(view.frame.as_ref().unwrap()));
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
fn a_long_pane_list_keeps_its_last_row_reachable(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.panes = (0..40)
            .map(|i| choice(&format!("pane-{i}"), "Shell"))
            .collect();
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    for _ in 0..10 {
        cx.simulate_event(ScrollWheelEvent {
            position: point(px(100.), px(200.)),
            delta: ScrollDelta::Pixels(point(px(0.), px(-300.))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
    let last = cx.debug_bounds("tmux-sidebar-pane:pane-39").unwrap();
    assert!(
        last.top() >= px(0.) && last.bottom() <= px(400.),
        "last pane must be reachable: {last:?}"
    );
    assert!(
        receiver.try_recv().is_err(),
        "sidebar scrolling must not send terminal input"
    );
}
