use super::*;
#[gpui::test]
fn context_only_search_keeps_duplicate_agent_route_and_narrow_bounds(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view,cx)=cx.add_window_view(|window,cx| {
        let mut view=make_view(window,cx,sender);
        view.browser_state.request=7;
        view.browser_state.home_agents=Some(serde_json::from_value(serde_json::json!({"revision":5,"phase":"live","rows":[
            {"key":"first","sessionId":"s","paneId":"p1","name":"Same","sessionLabel":"Session","machineLabel":"First host","serverLabel":"Shared","status":"WORKING","attention":true,"available":true},
            {"key":"second","sessionId":"s","paneId":"p2","name":"Same","sessionLabel":"Session","machineLabel":"界".repeat(160),"serverLabel":"🌍".repeat(160),"projectName":"Unique project","status":"WORKING","attention":true,"available":true}],"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap());
        view
    });
    cx.simulate_resize(size(px(520.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        view.update(cx, |view, cx| {
            view.home_filter
                .as_ref()
                .unwrap()
                .search
                .read(cx)
                .focus
                .clone()
                .focus(window, cx)
        });
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_input("unique project");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-home-agent-0").is_none());
    let row = cx.debug_bounds("tmux-home-agent-1").unwrap();
    let context = cx.debug_bounds("home-agent-context-1").unwrap();
    assert!(context.left() >= row.left() && context.right() <= row.right());
    let action = cx.debug_bounds("home-agent-action-1").unwrap();
    assert!(action.size.width > px(0.) && action.size.height > px(0.));
    assert!(action.left() >= row.left() && action.right() <= row.right());
    assert!(context.right() <= action.left());
    assert!(
        action.top() >= px(0.) && action.bottom() <= px(700.),
        "action outside viewport: {action:?}"
    );
    cx.simulate_click(action.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::OpenAgent{roster_revision:5,key,..} if key=="second")
    );
    assert!(receiver.try_recv().is_err());
}
