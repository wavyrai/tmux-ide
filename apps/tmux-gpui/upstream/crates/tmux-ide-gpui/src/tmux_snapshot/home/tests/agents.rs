use super::*;
fn roster() -> browser::home_agents::Roster {
    serde_json::from_value(serde_json::json!({"revision":4,"phase":"live","rows":[{"key":"session-two\u{0}agent","sessionId":"session-two","paneId":"pane-exact","name":"Same agent","sessionLabel":"Same name","status":"BLOCKED","attention":true,"available":true}],"observedSessions":2,"totalSessions":2,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap()
}
#[gpui::test]
fn rendered_agent_click_opens_exact_roster_identity(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = catalog_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.home_agents = Some(roster());
        view
    });
    cx.simulate_resize(size(px(520.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let row = cx.debug_bounds("tmux-home-agent-0").unwrap();
    let home = cx.debug_bounds("tmux-home").unwrap();
    assert!(row.left() >= home.left() && row.right() <= home.right());
    receiver.try_iter().for_each(drop);
    cx.simulate_click(row.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::OpenAgent { request:8,from_request:7,roster_revision:4,key } if key == "session-two\u{0}agent")
    );
    view.read_with(cx, |view, _| {
        assert!(view.frame.is_none());
        assert!(!view.browser_state.input_ready);
    });
}
#[gpui::test]
fn agent_dispatch_rejects_changed_revision_unavailable_and_disconnected(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = catalog_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.home_agents = Some(roster());
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.home_agent_select(7, 3, "session-two\u{0}agent", window, cx);
            view.browser_state.home_agents.as_mut().unwrap().rows[0].available = false;
            view.home_agent_select(7, 4, "session-two\u{0}agent", window, cx);
            view.browser_state.home_agents.as_mut().unwrap().rows[0].available = true;
            view.browser_state.surface = browser::Surface::Workspace;
            view.home_agent_select(7, 4, "session-two\0agent", window, cx);
            view.browser_state.surface = browser::Surface::Home;
            view.browser_commands = None;
            view.home_agent_select(7, 4, "session-two\u{0}agent", window, cx);
            assert_eq!(view.browser_request, 7);
        })
    });
    assert!(receiver.try_recv().is_err());
}
