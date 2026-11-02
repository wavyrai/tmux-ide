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
fn the_needs_input_pill_counts_waiting_agents_and_opens_the_first(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = catalog_view(window, cx, sender);
        view.browser_state.request = 7;
        view.browser_state.home_agents = Some(roster());
        view.browser_state.fleet = Some(fleet());
        view
    });
    cx.simulate_resize(size(px(1000.), px(900.)));
    let set_waiting = |cx: &mut VisualTestContext, waiting: bool| {
        cx.update(|window, cx| {
            view.update(cx, |v, _| {
                let roster = v.browser_state.home_agents.as_mut().unwrap();
                roster.rows[0].attention = waiting;
                roster.rows[0].status = if waiting {
                    browser::home_agents::Status::Blocked
                } else {
                    browser::home_agents::Status::Working
                };
            });
            window.draw(cx).clear(cx);
        })
    };
    // No agent waiting, no pill; one waiting, the pill.
    set_waiting(cx, false);
    assert!(cx.debug_bounds("home-agents-attention").is_none());
    assert!(
        cx.debug_bounds("fleet-session-agent-0-1").is_some(),
        "home not drawn"
    );
    set_waiting(cx, true);
    receiver.try_iter().for_each(drop);
    let pill = cx.debug_bounds("home-agents-attention").unwrap();
    cx.simulate_click(pill.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::OpenAgent { key, .. } if key == "session-two\u{0}agent")
    );
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
