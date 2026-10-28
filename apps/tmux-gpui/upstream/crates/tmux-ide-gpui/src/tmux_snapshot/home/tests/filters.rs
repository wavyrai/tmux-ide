use super::*;
use crate::tmux_snapshot::home::filters::Filter;
use browser::home_agents::{Phase, Roster, Status};
fn roster() -> Roster {
    serde_json::from_value(serde_json::json!({"revision":4,"phase":"live","rows":[
        {"key":"first","sessionId":"s","paneId":"p1","name":"Same agent","sessionLabel":"One","status":"WORKING","attention":false,"available":true},
        {"key":"second","sessionId":"s","paneId":"p2","name":"Same agent","sessionLabel":"Two","status":"BLOCKED","attention":false,"available":false}],
        "observedSessions":1,"totalSessions":2,"truncatedSessions":1,"truncatedRows":3,"note":null})).unwrap()
}
#[test]
fn filters_combine_display_search_with_authoritative_status() {
    let mut roster = roster();
    assert!(Filter::Working.matches(&roster, &roster.rows[0], " SAME "));
    assert!(!Filter::Working.matches(&roster, &roster.rows[0], "Two"));
    assert!(Filter::Attention.matches(&roster, &roster.rows[1], "two"));
    assert!(!roster.available("second"));
    roster.phase = Phase::Unavailable;
    assert!(!Filter::Working.matches(&roster, &roster.rows[0], ""));
    assert!(Filter::Attention.matches(&roster, &roster.rows[1], ""));
    roster.rows[1].status = Status::Failed;
    assert!(Filter::Attention.matches(&roster, &roster.rows[1], ""));
}
#[gpui::test]
fn home_search_filters_rows_without_terminal_commands_or_catalog_mutation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_agents = Some(roster());
        view
    });
    cx.simulate_resize(size(px(640.), px(900.)));
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
    cx.simulate_input("Two");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-home-agent-0").is_none());
    assert!(cx.debug_bounds("tmux-home-agent-1").is_some());
    view.read_with(cx, |view, _| {
        assert_eq!(view.browser_request, 7);
        assert_eq!(
            view.browser_state.home_agents.as_ref().unwrap().rows.len(),
            2
        );
        assert_eq!(
            view.browser_state
                .home_agents
                .as_ref()
                .unwrap()
                .truncated_rows,
            3
        );
    });
    let working = cx.debug_bounds("home-filter-Working").unwrap();
    cx.simulate_click(working.center(), Modifiers::default());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-home-agent-1").is_none());
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn home_search_is_not_an_appkit_terminal_composition_owner(cx: &mut TestAppContext) {
    let (sender, _) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.prepare_home_filter(cx);
            let search = view.home_filter.as_ref().unwrap().search.clone();
            search.read(cx).focus.clone().focus(window, cx);
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "に", Some(0..1), window, cx)
            });
            view.discard_composition(cx);
            assert!(search.read(cx).is_composing());
            assert!(
                !view.terminal_composition_owner(),
                "a Home publication must not discard the current AppKit search composition"
            );
            view.browser_state.surface = browser::Surface::Workspace;
            assert!(
                view.terminal_composition_owner(),
                "terminal cleanup remains enabled outside Home"
            );
        })
    });
}
