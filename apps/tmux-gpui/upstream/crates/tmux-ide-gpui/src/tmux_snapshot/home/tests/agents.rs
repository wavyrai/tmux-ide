use super::*;
fn roster() -> browser::home_agents::Roster {
    serde_json::from_value(serde_json::json!({"revision":4,"phase":"live","rows":[{"key":"session-two\u{0}agent","sessionId":"session-two","paneId":"pane-exact","name":"Same agent","sessionLabel":"Same name","status":"BLOCKED","attention":true,"available":true}],"observedSessions":2,"totalSessions":2,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap()
}
/// The fleet session the agent runs in, so Home shows it on that row (#705).
fn fleet() -> browser::fleet::Fleet {
    serde_json::from_value(
        serde_json::json!({"omittedGroups":0,"groups":[{"id":"local",
        "label":"Local","state":"ready","conflict":false,"omittedSessions":0,"sessions":[
        {"id":"local-one","name":"Same name","paneCount":1,"sessionId":"session-one",
         "selection":"70500000-0000-4000-8000-000000000001"},
        {"id":"local-two","name":"Same name","paneCount":1,"sessionId":"session-two",
         "selection":"70500000-0000-4000-8000-000000000002"}]}]}),
    )
    .unwrap()
}
#[gpui::test]
fn rendered_agent_click_opens_exact_roster_identity(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = catalog_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.home_agents = Some(roster());
        view.browser_state.fleet = Some(fleet());
        view
    });
    cx.simulate_resize(size(px(1000.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // The agent sits on its own session's row, not on the same-named one.
    assert!(cx.debug_bounds("fleet-session-agent-0-0").is_none());
    let agent = cx.debug_bounds("fleet-session-agent-0-1").unwrap();
    let row = cx.debug_bounds("fleet-session-0-1").unwrap();
    assert!(row.contains(&agent.center()));
    receiver.try_iter().for_each(drop);
    cx.simulate_click(agent.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::OpenAgent { request:8,from_request:7,roster_revision:4,key } if key == "session-two\u{0}agent")
    );
    assert!(receiver.try_recv().is_err(), "the row's own click ran too");
    view.read_with(cx, |view, _| {
        assert!(view.frame.is_none());
        assert!(!view.browser_state.input_ready);
    });
}
#[gpui::test]
fn the_needs_input_pill_filters_the_table_to_waiting_sessions(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = catalog_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.home_agents = Some(roster());
        view.browser_state.fleet = Some(fleet());
        view
    });
    cx.simulate_resize(size(px(1000.), px(900.)));
    let painted = |cx: &mut VisualTestContext, key: &'static str| {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.debug_bounds(key).is_some()
    };
    let click = |cx: &mut VisualTestContext, key: &'static str| {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let bounds = cx.debug_bounds(key).unwrap();
        cx.simulate_click(bounds.center(), Modifiers::default());
    };
    receiver.try_iter().for_each(drop);
    // Off: both sessions.
    assert!(painted(cx, "fleet-session-0-0") && painted(cx, "fleet-session-0-1"));
    // On: only the session whose agent waits, and the pill shows it is on.
    click(cx, "home-agents-attention-off");
    assert!(painted(cx, "home-agents-attention-on"));
    assert!(!painted(cx, "fleet-session-0-0"));
    assert!(painted(cx, "fleet-session-0-1"));
    // A second click shows them all again.
    click(cx, "home-agents-attention-on");
    assert!(painted(cx, "fleet-session-0-0") && painted(cx, "home-agents-attention-off"));
    // A left-list entry clears it too.
    click(cx, "home-agents-attention-off");
    click(cx, "home-nav-all");
    assert!(painted(cx, "fleet-session-0-0") && painted(cx, "home-agents-attention-off"));
    // The pill only filters: it sends nothing.
    assert!(receiver.try_recv().is_err());
    // No agent waiting: no pill, and a filter left on no longer narrows.
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.home_filter.as_mut().unwrap().waiting_only = true;
            let roster = v.browser_state.home_agents.as_mut().unwrap();
            roster.rows[0].attention = false;
            roster.rows[0].status = browser::home_agents::Status::Working;
        });
        window.draw(cx).clear(cx);
    });
    assert!(!painted(cx, "home-agents-attention-off") && !painted(cx, "home-agents-attention-on"));
    assert!(painted(cx, "fleet-session-0-0"));
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
